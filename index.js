const express = require('express');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;

// Stripe is optional at boot time so the server still loads without a key.
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ---------------- middleware ----------------
app.use(cors());
app.use(express.json());

// ---------------- mongodb ----------------
// Credentials come only from environment variables. A full DB_URI may be
// supplied instead; otherwise the Atlas SRV URI is built from DB_USER/DB_PASS.
const uri =
  process.env.DB_URI ||
  process.env.MONGODB_URI ||
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${
    process.env.DB_HOST || 'cluster0.mongodb.net'
  }/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const dbName = process.env.DB_NAME || 'assetManagementDB';
const database = client.db(dbName);
const userCollection = database.collection('users');
const assetCollection = database.collection('assets');
const requestCollection = database.collection('requests');
const paymentCollection = database.collection('payments');

// ---------------- helpers ----------------
const PACKAGES = {
  '5 Members': { members: 5, price: 5 },
  '10 Members': { members: 10, price: 8 },
  '20 Members': { members: 20, price: 15 },
};

const packageMembers = (pkg) => {
  if (!pkg) return 0;
  if (typeof pkg === 'number') return pkg;
  if (PACKAGES[pkg]) return PACKAGES[pkg].members;
  // Client package names/ids: 'Starter Team'/'basic' = 5,
  // 'Growing Team'/'standard' = 10, 'Full Office'/'premium' = 20.
  const key = String(pkg).toLowerCase();
  if (key.includes('starter') || key.includes('basic')) return 5;
  if (key.includes('growing') || key.includes('standard')) return 10;
  if (key.includes('full') || key.includes('premium')) return 20;
  const match = String(pkg).match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
};

const escapeRegex = (text = '') =>
  String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pageParams = (req) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = 10; // assignment rule: show 10 at a time
  return { page, limit, skip: (page - 1) * limit };
};

const isValidId = (id) => ObjectId.isValid(id);

// Team size is always derived from the users collection (no stored counter).
const teamCount = (hrEmail) => userCollection.countDocuments({ hrEmail });

// ---------------- auth middleware ----------------
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: 'unauthorized access' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' });
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: 'forbidden access' });
    }
    req.decoded = decoded;
    next();
  });
};

// Verifies (after verifyToken) that the caller is an HR Manager. The HR email
// checked is the token email unless an explicit hrEmail is supplied.
const verifyHR = async (req, res, next) => {
  try {
    const email = req.query.hrEmail || req.body?.hrEmail || req.decoded?.email;
    const user = await userCollection.findOne({ email });
    if (!user || user.role !== 'hr') {
      return res.status(403).send({ message: 'forbidden: HR access only' });
    }
    req.hrUser = user;
    next();
  } catch (error) {
    res.status(500).send({ message: 'failed to verify HR role', error: error.message });
  }
};

async function run() {
  try {
    // Routes are registered below; the native driver connects lazily on the
    // first database operation, so nothing here can block server startup.

    // ---------------- base ----------------
    app.get('/', (req, res) => {
      res.send('XYZ Asset Management server is running');
    });

    // ---------------- jwt ----------------
    app.post('/jwt', async (req, res) => {
      try {
        const user = req.body; // expects { email }
        if (!user?.email) {
          return res.status(400).send({ message: 'email is required' });
        }
        const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
          expiresIn: '1h',
        });
        res.send({ token });
      } catch (error) {
        res.status(500).send({ message: 'failed to create token', error: error.message });
      }
    });

    // ---------------- users ----------------
    const saveUser = async (req, res) => {
      try {
        const user = req.body;
        if (!user?.email) {
          return res.status(400).send({ message: 'email is required' });
        }
        // Upsert-safe: an existing user (e.g. social login re-save) keeps
        // their stored role, affiliation, package and payment status.
        const existing = await userCollection.findOne({ email: user.email });
        if (existing) {
          return res.send({ message: 'user already exists', insertedId: null });
        }
        const isHR = user.role === 'hr';
        const newUser = {
          name: user.name || '',
          email: user.email,
          photo: user.photo || user.photoURL || '',
          dob: user.dob || '',
          role: isHR ? 'hr' : 'employee',
          // HR-only fields (filled at HR registration)
          companyName: isHR ? user.companyName || '' : user.companyName || '',
          companyLogo: isHR ? user.companyLogo || '' : user.companyLogo || '',
          packageName: isHR ? user.packageName || '' : '',
          // The limit is granted by payment (POST /payments increments it),
          // so a freshly registered HR starts at 0 until paid:true.
          memberLimit: 0,
          paid: false,
          // Employee affiliation: null until an HR adds them to a team.
          // An HR manager is never their own team member, so their
          // hrEmail stays null even if the client sends one — otherwise
          // the HR would be counted in their own team count.
          hrEmail: isHR ? null : user.hrEmail || null,
          joinedDate: new Date(),
        };
        const result = await userCollection.insertOne(newUser);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'failed to save user', error: error.message });
      }
    };
    app.post('/users', saveUser);
    app.post('/users/social', saveUser); // alias from the plan's API draft

    app.get('/user/:email', verifyToken, async (req, res) => {
      try {
        const user = await userCollection.findOne({ email: req.params.email });
        if (!user) return res.status(404).send({ message: 'user not found' });
        res.send(user);
      } catch (error) {
        res.status(500).send({ message: 'failed to load user', error: error.message });
      }
    });

    // Profile update: name only (email is readonly). Photo is also accepted
    // if the client sends one, but no other field can be changed here.
    app.patch('/users/profile', verifyToken, async (req, res) => {
      try {
        const email = req.body?.email || req.decoded.email;
        const update = {};
        if (req.body?.name) update.name = req.body.name;
        if (req.body?.photo) update.photo = req.body.photo;
        if (!Object.keys(update).length) {
          return res.status(400).send({ message: 'nothing to update' });
        }
        const result = await userCollection.updateOne(
          { email },
          { $set: update }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'failed to update profile', error: error.message });
      }
    });

    app.get('/unaffiliated-users', verifyToken, async (req, res) => {
      try {
        const { limit, skip } = pageParams(req);
        const { search } = req.query;
        const query = {
          role: 'employee',
          $or: [{ hrEmail: null }, { hrEmail: { $exists: false } }],
        };
        if (search) query.name = { $regex: escapeRegex(search), $options: 'i' };
        const total = await userCollection.countDocuments(query);
        const users = await userCollection
          .find(query)
          .skip(skip)
          .limit(limit)
          .toArray();
        res.send({ users, total });
      } catch (error) {
        res.status(500).send({ message: 'failed to load users', error: error.message });
      }
    });

    console.log('Asset Management server routes are ready');
  } catch (error) {
    // Never let a database/setup problem stop the HTTP server from listening.
    console.error('Server setup failed, starting in degraded mode:', error.message);
  }
}

run();

// ---------------- error handler ----------------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send({ message: 'internal server error' });
});

app.listen(port, () => {
  console.log(`XYZ Asset Management server is running on port ${port}`);
});

module.exports = app;
