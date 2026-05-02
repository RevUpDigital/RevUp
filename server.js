const path = require("path");
require("dotenv").config();

const BASE_URL = process.env.BASE_URL || "https://www.revupdigital.com.au";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "price_1TRqKmBNSfcpwTI16biTcHKC";

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

/* ================= STRIPE WEBHOOK ================= */
/* Must be BEFORE app.use(express.json()) */
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("Stripe webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const checkoutSession = event.data.object;

        await User.findOneAndUpdate(
          { email: checkoutSession.customer_email },
          {
            stripeCustomerId: checkoutSession.customer,
            stripeSubscriptionId: checkoutSession.subscription,
            subscriptionStatus: "active",
          }
        );
      }

      if (event.type === "customer.subscription.updated") {
        const subscription = event.data.object;

        await User.findOneAndUpdate(
          { stripeCustomerId: subscription.customer },
          {
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
          }
        );
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;

        await User.findOneAndUpdate(
          { stripeCustomerId: subscription.customer },
          {
            subscriptionStatus: "canceled",
          }
        );
      }

      res.json({ received: true });
    } catch (err) {
      console.log("Webhook database error:", err);
      res.status(500).json({ error: "Webhook failed" });
    }
  }
);

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
  stripeCustomerId: String,
  stripeSubscriptionId: String,
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
    email: user.email,
    hasAccess: hasAccess(user),
    subscriptionStatus: user.subscriptionStatus,
    isAdmin: user.isAdmin,
    manualAccess: user.manualAccess,
  });
});

app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ success: false });
    }

    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login.html");
  });
});

app.post("/update-profile", requireAuth, async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;

  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    if (email && email !== user.email) {
      const existingUser = await User.findOne({ email });

      if (existingUser) {
        return res.json({ success: false, error: "Email already in use" });
      }

      user.email = email;
    }

    if (newPassword) {
      if (!currentPassword) {
        return res.json({ success: false, error: "Current password required" });
      }

      const valid = await bcrypt.compare(currentPassword, user.password);

      if (!valid) {
        return res.json({ success: false, error: "Current password is incorrect" });
      }

      if (newPassword.length < 6) {
        return res.json({ success: false, error: "New password must be at least 6 characters" });
      }

      user.password = await bcrypt.hash(newPassword, 10);
    }

    await user.save();

    res.json({ success: true });
  } catch (err) {
    console.log("Update profile error:", err);
    res.status(500).json({ success: false, error: "Could not update profile" });
  }
});

/* ================= STRIPE ================= */

app.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

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
      success_url: `${BASE_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/index.html`,
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.log("Stripe checkout error:", err);
    res.status(500).json({ error: "Could not create checkout session" });
  }
});

app.get("/payment-success", requireAuth, async (req, res) => {
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

app.get("/business/:slug", async (req, res) => {
  try {
    const business = await Business.findOne({ slug: req.params.slug });

    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    res.json(business);
  } catch (err) {
    res.status(500).json({ error: "Could not load business" });
  }
});

/* ================= SMS ================= */

app.post("/send-sms", requireAuth, requireAccess, async (req, res) => {
  const { name, phone, businessSlug } = req.body;

  try {
    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({ success: false, error: "Business not found" });
    }

    const reviewLink = `${BASE_URL}/review.html?business=${business.slug}&name=${encodeURIComponent(name)}`;

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
    console.log("SMS error:", err);
    res.status(500).json({ success: false, error: "Could not send SMS" });
  }
});

/* ================= FEEDBACK ================= */

app.post("/save-feedback", async (req, res) => {
  const { businessSlug, name, feedback } = req.body;

  try {
    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({ success: false, error: "Business not found" });
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
      subject: "New Feedback",
      text: feedback,
    });

    res.json({ success: true });
  } catch (err) {
    console.log("Feedback error:", err);
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