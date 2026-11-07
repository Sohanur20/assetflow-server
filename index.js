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

    // Add ONE employee to an HR's team, enforcing the package member limit.
    app.patch('/add-to-team', verifyToken, async (req, res) => {
      try {
        // Client sends { email, hrEmail }; accept employeeEmail too.
        const employeeEmail = req.body.employeeEmail || req.body.email;
        const { hrEmail } = req.body;
        if (!employeeEmail || !hrEmail) {
          return res.status(400).send({ message: 'employeeEmail and hrEmail are required' });
        }
        const hrUser = await userCollection.findOne({ email: hrEmail, role: 'hr' });
        if (!hrUser) return res.status(404).send({ message: 'HR manager not found' });

        const employee = await userCollection.findOne({ email: employeeEmail });
        if (!employee) return res.status(404).send({ message: 'employee not found' });
        if (employee.hrEmail) {
          return res.status(400).send({ message: 'employee is already affiliated with a company' });
        }

        const currentCount = await teamCount(hrEmail);
        const limit = hrUser.memberLimit || 0;
        if (currentCount >= limit) {
          return res.status(403).send({
            message: 'Member limit reached. Please increase your package limit.',
          });
        }

        const result = await userCollection.updateOne(
          { email: employeeEmail },
          {
            $set: {
              hrEmail,
              companyName: hrUser.companyName || '',
              companyLogo: hrUser.companyLogo || '',
            },
          }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'failed to add employee to team', error: error.message });
      }
    });

    // CHALLENGE: add many employees in ONE API call. The whole batch is
    // rejected if it would push the team past the HR's member limit.
    app.patch('/add-selected-to-team', verifyToken, async (req, res) => {
      try {
        // Client sends { emails, hrEmail }; accept employeeEmails too.
        const employeeEmails = req.body.employeeEmails || req.body.emails;
        const { hrEmail } = req.body;
        if (!Array.isArray(employeeEmails) || !employeeEmails.length || !hrEmail) {
          return res.status(400).send({ message: 'employeeEmails array and hrEmail are required' });
        }
        const hrUser = await userCollection.findOne({ email: hrEmail, role: 'hr' });
        if (!hrUser) return res.status(404).send({ message: 'HR manager not found' });

        // Only employees who exist and are still unaffiliated can be added.
        const addable = await userCollection
          .find({
            email: { $in: employeeEmails },
            role: 'employee',
            $or: [{ hrEmail: null }, { hrEmail: { $exists: false } }],
          })
          .project({ email: 1 })
          .toArray();
        const addableEmails = addable.map((u) => u.email);
        if (!addableEmails.length) {
          return res.status(400).send({ message: 'no unaffiliated employees to add' });
        }

        const currentCount = await teamCount(hrEmail);
        const limit = hrUser.memberLimit || 0;
        if (currentCount + addableEmails.length > limit) {
          return res.status(403).send({
            message: `Member limit reached. Your package allows ${limit} members, current team is ${currentCount}, and you selected ${addableEmails.length}.`,
          });
        }

        const result = await userCollection.updateMany(
          { email: { $in: addableEmails } },
          {
            $set: {
              hrEmail,
              companyName: hrUser.companyName || '',
              companyLogo: hrUser.companyLogo || '',
            },
          }
        );
        res.send({ ...result, addedCount: result.modifiedCount });
      } catch (error) {
        res.status(500).send({ message: 'failed to add selected employees', error: error.message });
      }
    });

    app.patch('/remove-from-team/:email', verifyToken, async (req, res) => {
      try {
        const result = await userCollection.updateOne(
          { email: req.params.email },
          { $set: { hrEmail: null, companyName: '', companyLogo: '' } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'failed to remove employee from team', error: error.message });
      }
    });

    // My Team (employee view) / team members of an HR.
    app.get('/my-team', verifyToken, async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).send({ message: 'email is required' });
        const user = await userCollection.findOne({ email });
        if (!user) return res.status(404).send({ message: 'user not found' });
        const hrEmail = user.role === 'hr' ? user.email : user.hrEmail;
        if (!hrEmail) return res.send({ hr: null, team: [], total: 0 });
        const hr = await userCollection.findOne({ email: hrEmail });
        const team = await userCollection.find({ hrEmail }).toArray();
        res.send({ hr, team, total: team.length });
      } catch (error) {
        res.status(500).send({ message: 'failed to load team', error: error.message });
      }
    });

    // Team members for the client: GET /team-members?hrEmail=<hr email>
    // Used by both the employee "My Team" page and the HR "My Employee
    // List" page. Members include the HR manager (as admin) followed by
    // every employee affiliated with that HR.
    app.get('/team-members', verifyToken, async (req, res) => {
      try {
        const hrEmail = req.query.hrEmail || req.query.email || req.decoded.email;
        const hr = await userCollection.findOne({ email: hrEmail });
        const employees = await userCollection.find({ hrEmail }).toArray();
        const members = hr ? [hr, ...employees] : employees;
        res.send({ members, team: employees, hr: hr || null, total: employees.length });
      } catch (error) {
        res.status(500).send({ message: 'failed to load team members', error: error.message });
      }
    });

    app.get('/employees/hr', verifyToken, async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) return res.status(400).send({ message: 'email is required' });
        const { limit, skip } = pageParams(req);
        const query = { hrEmail: email };
        const total = await userCollection.countDocuments(query);
        const employees = await userCollection.find(query).skip(skip).limit(limit).toArray();
        res.send({ employees, total });
      } catch (error) {
        res.status(500).send({ message: 'failed to load employees', error: error.message });
      }
    });

    // ---------------- assets ----------------
    app.post('/assets', verifyToken, verifyHR, async (req, res) => {
      try {
        const body = req.body;
        const hrEmail = body.hrEmail || req.decoded.email;
        const hrUser =
          req.hrUser?.email === hrEmail
            ? req.hrUser
            : await userCollection.findOne({ email: hrEmail });
        const asset = {
          productName: body.productName || '',
          productType: body.productType || 'returnable',
          quantity: parseInt(body.quantity ?? body.productQuantity, 10) || 0,
          dateAdded: body.dateAdded ? new Date(body.dateAdded) : new Date(),
          hrEmail,
          companyName: body.companyName || hrUser?.companyName || '',
          companyLogo: body.companyLogo || hrUser?.companyLogo || '',
        };
        const result = await assetCollection.insertOne(asset);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'failed to add asset', error: error.message });
      }
    });

    app.get('/assets/hr', verifyToken, async (req, res) => {
      try {
        const { search, stock, type } = req.query;
        // Client relies on the JWT instead of sending its email.
        const email = req.query.email || req.decoded.email;
        const sortByQuantity = req.query.sortByQuantity || req.query.sort;
        const { limit, skip } = pageParams(req);
        const query = { hrEmail: email };
        if (search) query.productName = { $regex: escapeRegex(search), $options: 'i' };
        if (type) query.productType = type;
        if (stock) {
          if (String(stock).toLowerCase().includes('out')) query.quantity = { $lte: 0 };
          else query.quantity = { $gt: 0 };
        }
        const total = await assetCollection.countDocuments(query);
        let cursor = assetCollection.find(query);
        if (sortByQuantity) {
          const direction =
            sortByQuantity === 'desc' || sortByQuantity === '-1' ? -1 : 1;
          cursor = cursor.sort({ quantity: direction });
        } else {
          cursor = cursor.sort({ dateAdded: -1 });
        }
        const assets = await cursor.skip(skip).limit(limit).toArray();
        res.send({ assets, total });
      } catch (error) {
        res.status(500).send({ message: 'failed to load assets', error: error.message });
      }
    });

    app.get('/assets/employee', verifyToken, async (req, res) => {
      try {
        const { search, availability, type } = req.query;
        // Client relies on the JWT: resolve the employee's HR from
        // their own user record when hrEmail is not sent explicitly.
        let hrEmail = req.query.hrEmail;
        if (!hrEmail) {
          const me = await userCollection.findOne({ email: req.decoded.email });
          hrEmail = me?.role === 'hr' ? me.email : me?.hrEmail;
        }
        if (!hrEmail) return res.status(400).send({ message: 'hrEmail is required' });
        const { limit, skip } = pageParams(req);
        const query = { hrEmail };
        if (search) query.productName = { $regex: escapeRegex(search), $options: 'i' };
        if (type) query.productType = type;
        if (availability) {
          if (String(availability).toLowerCase().includes('out')) query.quantity = { $lte: 0 };
          else query.quantity = { $gt: 0 };
        }
        const total = await assetCollection.countDocuments(query);
        const assets = await assetCollection
          .find(query)
          .sort({ dateAdded: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();
        res.send({ assets, total });
      } catch (error) {
        res.status(500).send({ message: 'failed to load assets', error: error.message });
      }
    });

    app.patch('/assets/:id', verifyToken, async (req, res) => {
      try {
        if (!isValidId(req.params.id)) {
          return res.status(400).send({ message: 'invalid asset id' });
        }
        const update = {};
        if (req.body.productName !== undefined) update.productName = req.body.productName;
        if (req.body.productType !== undefined) update.productType = req.body.productType;
        const qty = req.body.quantity ?? req.body.productQuantity;
        if (qty !== undefined) update.quantity = parseInt(qty, 10) || 0;
        const result = await assetCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: update }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'failed to update asset', error: error.message });
      }
    });

    app.delete('/assets/:id', verifyToken, async (req, res) => {
      try {
        if (!isValidId(req.params.id)) {
          return res.status(400).send({ message: 'invalid asset id' });
        }
        const result = await assetCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'failed to delete asset', error: error.message });
      }
    });

    // ---------------- requests ----------------
    app.post('/requests', verifyToken, async (req, res) => {
      try {
        const body = req.body;
        let asset = null;
        if (body.assetId && isValidId(body.assetId)) {
          asset = await assetCollection.findOne({ _id: new ObjectId(body.assetId) });
        }
        const request = {
          assetId: body.assetId || (asset ? String(asset._id) : ''),
          assetName: body.assetName || asset?.productName || '',
          assetType: body.assetType || asset?.productType || 'returnable',
          requesterName: body.requesterName || '',
          requesterEmail: body.requesterEmail || req.decoded.email,
          requesterPhoto: body.requesterPhoto || '',
          hrEmail: body.hrEmail || asset?.hrEmail || '',
          companyName: body.companyName || asset?.companyName || '',
          companyLogo: body.companyLogo || asset?.companyLogo || '',
          additionalNote: body.additionalNote || '',
          requestDate: new Date(),
          approvalDate: null,
          status: 'pending',
        };
        const result = await requestCollection.insertOne(request);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'failed to create request', error: error.message });
      }
    });

    app.get('/requests/my', verifyToken, async (req, res) => {
      try {
        const { search, status, type } = req.query;
        const email = req.query.email || req.decoded.email;
        const { limit, skip } = pageParams(req);
        const query = { requesterEmail: email };
        if (search) query.assetName = { $regex: escapeRegex(search), $options: 'i' };
        if (status) query.status = status;
        if (type) query.assetType = type;
        const total = await requestCollection.countDocuments(query);
        const requests = await requestCollection
          .find(query)
          .sort({ requestDate: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();
        res.send({ requests, total });
      } catch (error) {
        res.status(500).send({ message: 'failed to load requests', error: error.message });
      }
    });

    app.get('/requests/hr', verifyToken, async (req, res) => {
      try {
        const { search } = req.query;
        const email = req.query.email || req.decoded.email;
        const { limit, skip } = pageParams(req);
        const query = { hrEmail: email };
        if (search) {
          const regex = { $regex: escapeRegex(search), $options: 'i' };
          query.$or = [{ requesterName: regex }, { requesterEmail: regex }];
        }
        const total = await requestCollection.countDocuments(query);
        const requests = await requestCollection
          .find(query)
          .sort({ requestDate: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();
        res.send({ requests, total });
      } catch (error) {
        res.status(500).send({ message: 'failed to load requests', error: error.message });
      }
    });

    const findRequest = (id) =>
      requestCollection.findOne({ _id: new ObjectId(id) });

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
