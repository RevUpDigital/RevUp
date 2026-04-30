const path = require("path");
require("dotenv").config();

const BASE_URL = process.env.BASE_URL || "https://www.revupdigital.com.au";

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const mongoose = require("mongoose");
const { Resend } = require("resend");

const session = require("express-session");
const MongoStore = require("connect-mongo").default || require("connect-mongo");
const bcrypt = require("bcryptjs");

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json());
app.use(cors());

/* ================= SESSION SETUP ================= */
app.use(
  session({
    secret: "revup-secret",
    resave: false,
    saveUninitialized: false,
    //store: MongoStore.create({
    //  mongoUrl: process.env.MONGODB_URI,
    //}),
    cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 day
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

// USER MODEL
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  isAdmin: { type: Boolean, default: false },
  manualAccess: { type: Boolean, default: false },
});

const User = mongoose.model("User", userSchema);

// BUSINESS MODEL
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

// FEEDBACK MODEL
const feedbackSchema = new mongoose.Schema({
  businessSlug: String,
  businessName: String,
  name: String,
  feedback: String,
  date: { type: Date, default: Date.now },
});

const Feedback = mongoose.model("Feedback", feedbackSchema);

/* ================= AUTH MIDDLEWARE ================= */
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, error: "Not logged in" });
  }
  next();
}

/* ================= AUTH ROUTES ================= */

// REGISTER
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

// LOGIN
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

// LOGOUT
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// CURRENT USER
app.get("/me", async (req, res) => {
  if (!req.session.userId) {
    return res.json({ loggedIn: false });
  }

  const user = await User.findById(req.session.userId);

  res.json({
    loggedIn: true,
    email: user.email,
    manualAccess: user.manualAccess,
    isAdmin: user.isAdmin,
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

app.post("/send-sms", requireAuth, async (req, res) => {
  const { name, phone, businessSlug } = req.body;

  try {
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

  } catch (err) {
    res.status(500).json({ success: false });
  }
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
    subject: `New Feedback`,
    text: feedback,
  });

  res.json({ success: true });
});

app.get("/get-feedback", requireAuth, async (req, res) => {
  const { businessSlug } = req.query;

  const feedback = await Feedback.find({ businessSlug }).sort({ date: -1 });

  res.json(feedback);
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});