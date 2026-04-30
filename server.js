const path = require("path");
require("dotenv").config();

const BASE_URL = process.env.BASE_URL || "https://www.revupdigital.com.au";
const STRIPE_PRICE_ID = "price_1TRqKmBNSfcpwTI16biTcHKC";

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

/* ================= SESSION ================= */
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
  subscriptionStatus: { type: String, default: "none" },
});

const User = mongoose.model("User", userSchema);

const businessSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  businessName: String,
  slug: { type: String, unique: true },
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

/* ================= AUTH ================= */

function hasAccess(user) {
  return (
    user.isAdmin ||
    user.manualAccess ||
    user.subscriptionStatus === "active" ||
    user.subscriptionStatus === "trialing"
  );
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }
  next();
}

async function requireAccess(req, res, next) {
  const user = await User.findById(req.session.userId);

  if (!user || !hasAccess(user)) {
    return res.status(403).json({ error: "No access" });
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

  if (!user) return res.json({ success: false });

  const valid = await bcrypt.compare(password, user.password);

  if (!valid) return res.json({ success: false });

  req.session.userId = user._id;

  res.json({ success: true });
});

app.get("/me", async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });

  const user = await User.findById(req.session.userId);

  res.json({
    loggedIn: true,
    hasAccess: hasAccess(user),
  });
});

/* ================= STRIPE ================= */

app.post("/create-checkout-session", requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);

  const session = await stripe.checkout.sessions.create({
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
    cancel_url: `${BASE_URL}/index.html`,
  });

  res.json({ url: session.url });
});

app.get("/payment-success", requireAuth, async (req, res) => {
  await User.findByIdAndUpdate(req.session.userId, {
    subscriptionStatus: "active",
  });

  res.redirect("/index.html");
});

/* ================= BUSINESS ================= */

app.post("/create-business", requireAuth, async (req, res) => {
  const { businessName, slug, email, googleReviewLink, smsMessage } = req.body;

  try {
    const business = await Business.create({
      userId: req.session.userId,
      businessName,
      slug,
      email,
      googleReviewLink,
      smsMessage,
      feedbackHeading: "We're sorry to hear that",
    });

    res.json({ success: true, business });
  } catch (err) {
    res.json({ success: false, error: "duplicate" });
  }
});

/* ================= SMS ================= */

app.post("/send-sms", requireAuth, requireAccess, async (req, res) => {
  const { name, phone, businessSlug } = req.body;

  const business = await Business.findOne({ slug: businessSlug });

  const reviewLink = `${BASE_URL}/review.html?business=${business.slug}&name=${name}`;

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
});

/* ================= FEEDBACK ================= */

app.post("/save-feedback", async (req, res) => {
  const { businessSlug, name, feedback } = req.body;

  const business = await Business.findOne({ slug: businessSlug });

  await Feedback.create({
    businessSlug,
    businessName: business.businessName,
    name,
    feedback,
  });

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: business.email,
    subject: "New Feedback",
    text: feedback,
  });

  res.json({ success: true });
});

app.get("/get-feedback", requireAuth, requireAccess, async (req, res) => {
  const { businessSlug } = req.query;

  const feedback = await Feedback.find({ businessSlug });

  res.json(feedback);
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});