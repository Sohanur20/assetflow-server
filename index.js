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
