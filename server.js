const path = require("path");
require("dotenv").config();

const BASE_URL = process.env.BASE_URL || "https://www.revupdigital.com.au";

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const mongoose = require("mongoose");
const { Resend } = require("resend");

const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(cors());

/* ================= SESSION SETUP ================= */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "revup-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

/* ================= ROUTES ================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.use(express.static(path.join(__dirname, "public")));

/* ================= DATABASE ================= */
mongoose
  .connect(process.env.MONGODB_URI, { dbName: "revup" })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB error:", err));

/* ================= MODELS ================= */

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  isAdmin: { type: Boolean, default: false },
  manualAccess: { type: Boolean, default: false },
  subscriptionStatus: {
    type: String,
    default: "none",
  },
});

const User = mongoose.model("User", userSchema);

const businessSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  businessName: String,
  slug: { type: String, unique: true, required: true },
  email: String,
  googleReviewLink: String,
  smsMessage: String,
  feedbackHeading: String,
});

const Business = mongoose.model("Business", businessSchema);

const feedbackSchema = new mongoose.Schema({
  businessSlug: String,
  businessName: String,
  name: String,
  feedback: String,
  date: { type: Date, default: Date.now },
});

const Feedback = mongoose.model("Feedback", feedbackSchema);

/* ================= AUTH HELPERS ================= */

function hasUserAccess(user) {
  return (
    user.isAdmin ||
    user.manualAccess ||
    user.subscriptionStatus === "active" ||
    user.subscriptionStatus === "trialing"
  );
}

/* ================= AUTH MIDDLEWARE ================= */

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }

  next();
}

async function requireAccess(req, res, next) {
  const user = await User.findById(req.session.userId);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: "Not logged in",
    });
  }

  if (!hasUserAccess(user)) {
    return res.status(403).json({
      success: false,
      error: "No active subscription",
    });
  }

  next();
}

/* ================= AUTH ROUTES ================= */

app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  try {
    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      email,
      password: hashed,
    });

    req.session.userId = user._id;

    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ success: false, error: "duplicate" });
    }

    res.status(500).json({ success: false });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user) {
    return res.json({ success: false, error: "invalid" });
  }

  const valid = await bcrypt.compare(password, user.password);

  if (!valid) {
    return res.json({ success: false, error: "invalid" });
  }

  req.session.userId = user._id;

  res.json({ success: true });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/me", async (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }

  const user = await User.findById(req.session.userId);

  if (!user) {
    return res.json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    email: user.email,
    manualAccess: user.manualAccess,
    isAdmin: user.isAdmin,
    subscriptionStatus: user.subscriptionStatus,
    hasAccess: hasUserAccess(user),
  });
});

/* ================= BUSINESS ================= */

app.post("/create-business", requireAuth, async (req, res) => {
  try {
    const {
      businessName,
      slug,
      email,
      googleReviewLink,
      smsMessage,
    } = req.body;

    const feedbackHeading = "We're sorry to hear that";

    const business = await Business.create({
      userId: req.session.userId,
      businessName,
      slug,
      email,
      googleReviewLink,
      smsMessage,
      feedbackHeading,
    });

    res.json({ success: true, business });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ success: false, error: "duplicate" });
    }

    res.status(500).json({ success: false });
  }
});

app.get("/business/:slug", async (req, res) => {
  const business = await Business.findOne({ slug: req.params.slug });

  if (!business) {
    return res.status(404).json({ success: false });
  }

  res.json(business);
});

/* ================= SMS ================= */

app.post("/send-sms", requireAuth, requireAccess, async (req, res) => {
  const { name, phone, businessSlug } = req.body;

  try {
    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({
        success: false,
        error: "Business not found",
      });
    }

    const reviewLink = `${BASE_URL}/review.html?business=${encodeURIComponent(
      business.slug
    )}&name=${encodeURIComponent(name)}`;

    const message = business.smsMessage
      .replaceAll("{{name}}", name)
      .replaceAll("{{reviewLink}}", reviewLink);

    await axios.post(
      "https://rest.clicksend.com/v3/sms/send",
      {
        messages: [{ body: message, to: phone }],
      },
      {
        auth: {
          username: process.env.CLICKSEND_USERNAME,
          password: process.env.CLICKSEND_API_KEY,
        },
      }
    );

    res.json({ success: true });
  } catch (err) {
    console.log("SEND SMS ERROR:", err.response?.data || err.message);
    res.status(500).json({ success: false });
  }
});

/* ================= FEEDBACK ================= */

app.post("/save-feedback", async (req, res) => {
  const { businessSlug, name, feedback } = req.body;

  try {
    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({
        success: false,
        error: "Business not found",
      });
    }

    await Feedback.create({
      businessSlug,
      businessName: business.businessName,
      name,
      feedback,
    });

    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: business.email,
      subject: `New Feedback`,
      text: feedback,
    });

    res.json({ success: true });
  } catch (err) {
    console.log("SAVE FEEDBACK ERROR:", err);
    res.status(500).json({ success: false });
  }
});

app.get("/get-feedback", requireAuth, requireAccess, async (req, res) => {
  const { businessSlug } = req.query;

  const feedback = await Feedback.find({ businessSlug }).sort({ date: -1 });

  res.json(feedback);
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});const path = require("path");
require("dotenv").config();

const BASE_URL = process.env.BASE_URL || "https://www.revupdigital.com.au";
const STRIPE_PRICE_ID = price_1TRqKmBNSfcpwTI16biTcHKC;

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const mongoose = require("mongoose");
const { Resend } = require("resend");

const session = require("express-session");
const bcrypt = require("bcryptjs");

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json());
app.use(cors());

/* ================= SESSION SETUP ================= */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "revup-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

/* ================= ROUTES ================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.use(express.static(path.join(__dirname, "public")));

/* ================= DATABASE ================= */
mongoose
  .connect(process.env.MONGODB_URI, { dbName: "revup" })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log("MongoDB error:", err));

/* ================= MODELS ================= */

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  isAdmin: { type: Boolean, default: false },
  manualAccess: { type: Boolean, default: false },
  subscriptionStatus: {
    type: String,
    default: "none",
  },
});

const User = mongoose.model("User", userSchema);

const businessSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  businessName: String,
  slug: { type: String, unique: true, required: true },
  email: String,
  googleReviewLink: String,
  smsMessage: String,
  feedbackHeading: String,
});

const Business = mongoose.model("Business", businessSchema);

const feedbackSchema = new mongoose.Schema({
  businessSlug: String,
  businessName: String,
  name: String,
  feedback: String,
  date: { type: Date, default: Date.now },
});

const Feedback = mongoose.model("Feedback", feedbackSchema);

/* ================= AUTH HELPERS ================= */

function hasUserAccess(user) {
  return (
    user.isAdmin ||
    user.manualAccess ||
    user.subscriptionStatus === "active" ||
    user.subscriptionStatus === "trialing"
  );
}

/* ================= AUTH MIDDLEWARE ================= */

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }

  next();
}

async function requireAccess(req, res, next) {
  const user = await User.findById(req.session.userId);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: "Not logged in",
    });
  }

  if (!hasUserAccess(user)) {
    return res.status(403).json({
      success: false,
      error: "No active subscription",
    });
  }

  next();
}

/* ================= AUTH ROUTES ================= */

app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  try {
    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      email,
      password: hashed,
    });

    req.session.userId = user._id;

    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ success: false, error: "duplicate" });
    }

    res.status(500).json({ success: false });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });

  if (!user) {
    return res.json({ success: false, error: "invalid" });
  }

  const valid = await bcrypt.compare(password, user.password);

  if (!valid) {
    return res.json({ success: false, error: "invalid" });
  }

  req.session.userId = user._id;

  res.json({ success: true });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/me", async (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }

  const user = await User.findById(req.session.userId);

  if (!user) {
    return res.json({ loggedIn: false });
  }

  res.json({
    loggedIn: true,
    email: user.email,
    manualAccess: user.manualAccess,
    isAdmin: user.isAdmin,
    subscriptionStatus: user.subscriptionStatus,
    hasAccess: hasUserAccess(user),
  });
});

/* ================= STRIPE ================= */

app.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Not logged in",
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: user.email,
      line_items: [
        {
          price: STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/payment-success`,
      cancel_url: `${BASE_URL}/index.html?payment=cancel`,
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.log("STRIPE CHECKOUT ERROR:", err);
    res.status(500).json({
      success: false,
      error: "Failed to create checkout session",
    });
  }
});

app.get("/payment-success", requireAuth, async (req, res) => {
  await User.findByIdAndUpdate(req.session.userId, {
    subscriptionStatus: "active",
  });

  res.redirect("/index.html?payment=success");
});

/* ================= BUSINESS ================= */

app.post("/create-business", requireAuth, async (req, res) => {
  try {
    const {
      businessName,
      slug,
      email,
      googleReviewLink,
      smsMessage,
    } = req.body;

    const feedbackHeading = "We're sorry to hear that";

    const business = await Business.create({
      userId: req.session.userId,
      businessName,
      slug,
      email,
      googleReviewLink,
      smsMessage,
      feedbackHeading,
    });

    res.json({ success: true, business });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ success: false, error: "duplicate" });
    }

    res.status(500).json({ success: false });
  }
});

app.get("/business/:slug", async (req, res) => {
  const business = await Business.findOne({ slug: req.params.slug });

  if (!business) {
    return res.status(404).json({ success: false });
  }

  res.json(business);
});

/* ================= SMS ================= */

app.post("/send-sms", requireAuth, requireAccess, async (req, res) => {
  const { name, phone, businessSlug } = req.body;

  try {
    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({
        success: false,
        error: "Business not found",
      });
    }

    const reviewLink = `${BASE_URL}/review.html?business=${encodeURIComponent(
      business.slug
    )}&name=${encodeURIComponent(name)}`;

    const message = business.smsMessage
      .replaceAll("{{name}}", name)
      .replaceAll("{{reviewLink}}", reviewLink);

    await axios.post(
      "https://rest.clicksend.com/v3/sms/send",
      {
        messages: [{ body: message, to: phone }],
      },
      {
        auth: {
          username: process.env.CLICKSEND_USERNAME,
          password: process.env.CLICKSEND_API_KEY,
        },
      }
    );

    res.json({ success: true });
  } catch (err) {
    console.log("SEND SMS ERROR:", err.response?.data || err.message);
    res.status(500).json({ success: false });
  }
});

/* ================= FEEDBACK ================= */

app.post("/save-feedback", async (req, res) => {
  const { businessSlug, name, feedback } = req.body;

  try {
    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({
        success: false,
        error: "Business not found",
      });
    }

    await Feedback.create({
      businessSlug,
      businessName: business.businessName,
      name,
      feedback,
    });

    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: business.email,
      subject: `New Feedback`,
      text: feedback,
    });

    res.json({ success: true });
  } catch (err) {
    console.log("SAVE FEEDBACK ERROR:", err);
    res.status(500).json({ success: false });
  }
});

app.get("/get-feedback", requireAuth, requireAccess, async (req, res) => {
  const { businessSlug } = req.query;

  const feedback = await Feedback.find({ businessSlug }).sort({ date: -1 });

  res.json(feedback);
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});