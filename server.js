const path = require("path");
require("dotenv").config();

const BASE_URL = process.env.BASE_URL || "https://www.revupdigital.com.au";
const STRIPE_BASIC_PRICE_ID = process.env.STRIPE_BASIC_PRICE_ID;
const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID;

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

        const plan = checkoutSession.metadata?.plan || "basic";

        await User.findOneAndUpdate(
          { email: checkoutSession.customer_email },
          {
            stripeCustomerId: checkoutSession.customer,
            stripeSubscriptionId: checkoutSession.subscription,
            subscriptionStatus: "active",
            plan,
          }
        );
      }

      if (event.type === "customer.subscription.updated") {
        const subscription = event.data.object;

        const priceId = subscription.items?.data?.[0]?.price?.id;

        let plan = "basic";

        if (priceId === STRIPE_PRO_PRICE_ID) {
          plan = "pro";
        }

        if (priceId === STRIPE_BASIC_PRICE_ID) {
          plan = "basic";
        }

        await User.findOneAndUpdate(
          { stripeCustomerId: subscription.customer },
          {
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
            plan,
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
  plan: { type: String, default: "basic" },

  smsUsedThisMonth: { type: Number, default: 0 },
  smsResetDate: { type: Date, default: Date.now },
  smsWarning80Sent: { type: Boolean, default: false },
  smsWarning100Sent: { type: Boolean, default: false },

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

const reviewEventSchema = new mongoose.Schema({
  businessSlug: String,
  businessName: String,
  customerName: String,
  eventType: String,
  date: { type: Date, default: Date.now }
});

const ReviewEvent = mongoose.model("ReviewEvent", reviewEventSchema);


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
    const plan = req.body?.plan || "basic";

    const selectedPlan = plan === "pro" ? "pro" : "basic";

    const priceId =
      selectedPlan === "pro"
        ? STRIPE_PRO_PRICE_ID
        : STRIPE_BASIC_PRICE_ID;

    if (!priceId) {
      return res.status(500).json({
        error: `Missing Stripe price ID for ${selectedPlan} plan`,
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: user.email,
      client_reference_id: user._id.toString(),
      metadata: {
        plan: selectedPlan,
      },
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          plan: selectedPlan,
        },
      },
      line_items: [
        {
          price: priceId,
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

app.post("/create-billing-portal-session", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user || !user.stripeCustomerId) {
      return res.status(400).json({
        error: "No Stripe customer found. Please subscribe first.",
      });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${BASE_URL}/profile.html`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.log("Billing portal error:", err);
    res.status(500).json({ error: "Could not open billing portal" });
  }
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

const PLAN_LIMITS = {
  basic: 150,
  pro: 400,
};

function getSmsLimit(user) {
  if (user.isAdmin) return Infinity;

  return PLAN_LIMITS[user.plan] || PLAN_LIMITS.basic;
}

function isAllowedPhoneNumber(phone) {
  return phone.startsWith("+61") || phone.startsWith("+64");
}

function needsSmsReset(user) {
  const now = new Date();
  const resetDate = new Date(user.smsResetDate);

  return (
    now.getMonth() !== resetDate.getMonth() ||
    now.getFullYear() !== resetDate.getFullYear()
  );
}

async function resetSmsIfNeeded(user) {
  if (!needsSmsReset(user)) return;

  user.smsUsedThisMonth = 0;
  user.smsResetDate = new Date();
  user.smsWarning80Sent = false;
  user.smsWarning100Sent = false;

  await user.save();
}

async function sendSmsUsageEmail(user, type, used, limit) {
  if (!user.email || limit === Infinity) return;

  let subject = "";
  let text = "";

  if (type === "80") {
    subject = "RevUp SMS usage warning";
    text = `You have used ${used}/${limit} SMS this month. You are getting close to your monthly SMS limit.`;
  }

  if (type === "100") {
    subject = "RevUp SMS limit reached";
    text = `You have reached your monthly SMS limit of ${limit} SMS. SMS sending is now paused until your monthly reset.`;
  }

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: user.email,
    subject,
    text,
  });
}

app.post("/send-sms", requireAuth, requireAccess, async (req, res) => {
  const { name, phone, businessSlug } = req.body;

  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({ success: false, error: "User not found" });
    }

    if (!isAllowedPhoneNumber(phone)) {
      return res.status(400).json({
        success: false,
        error: "Only Australian (+61) and New Zealand (+64) phone numbers are allowed.",
      });
    }

    await resetSmsIfNeeded(user);

    const smsLimit = getSmsLimit(user);

    if (user.smsUsedThisMonth >= smsLimit) {
      if (!user.smsWarning100Sent && smsLimit !== Infinity) {
        await sendSmsUsageEmail(user, "100", user.smsUsedThisMonth, smsLimit);
        user.smsWarning100Sent = true;
        await user.save();
      }

      return res.status(403).json({
        success: false,
        error: `SMS limit reached. You have used ${user.smsUsedThisMonth}/${smsLimit} SMS this month.`,
      });
    }

    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({ success: false, error: "Business not found" });
    }

    const reviewLink = `${BASE_URL}/review.html?business=${business.slug}&name=${encodeURIComponent(name)}`;

    const message = business.smsMessage
      .replaceAll("{{name}}", name)
      .replaceAll("{{reviewLink}}", reviewLink);

    const clicksendResponse = await axios.post(
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

    console.log("ClickSend response:", JSON.stringify(clicksendResponse.data, null, 2));

    const messageResult = clicksendResponse.data?.data?.messages?.[0];

    if (!messageResult || messageResult.status !== "SUCCESS") {
      console.log("SMS failed:", messageResult);

      return res.status(400).json({
        success: false,
        error: messageResult?.status || "SMS failed to send",
      });
    }

    user.smsUsedThisMonth += 1;

    const usagePercent = user.smsUsedThisMonth / smsLimit;

    if (
      smsLimit !== Infinity &&
      usagePercent >= 0.8 &&
      !user.smsWarning80Sent
    ) {
      await sendSmsUsageEmail(user, "80", user.smsUsedThisMonth, smsLimit);
      user.smsWarning80Sent = true;
    }

    if (
      smsLimit !== Infinity &&
      user.smsUsedThisMonth >= smsLimit &&
      !user.smsWarning100Sent
    ) {
      await sendSmsUsageEmail(user, "100", user.smsUsedThisMonth, smsLimit);
      user.smsWarning100Sent = true;
    }

    await user.save();

    await ReviewEvent.create({
      businessSlug,
      businessName: business.businessName,
      customerName: name,
      eventType: "sms_sent",
    });

    res.json({
      success: true,
      smsUsedThisMonth: user.smsUsedThisMonth,
      smsLimit: smsLimit === Infinity ? "unlimited" : smsLimit,
      smsRemaining: smsLimit === Infinity ? "unlimited" : smsLimit - user.smsUsedThisMonth,
    });
  } catch (err) {
    console.log("SMS error:", err);
    res.status(500).json({ success: false, error: "Could not send SMS" });
  }
});

app.get("/user-usage", requireAuth, requireAccess, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    await resetSmsIfNeeded(user);

    const smsLimit = getSmsLimit(user);

    res.json({
      smsUsed: user.smsUsedThisMonth,
      smsLimit: smsLimit === Infinity ? "unlimited" : smsLimit,
      smsRemaining: smsLimit === Infinity ? "unlimited" : Math.max(smsLimit - user.smsUsedThisMonth, 0),
      plan: user.plan || "basic",
    });
  } catch (err) {
    console.log("Usage error:", err);
    res.status(500).json({ error: "Could not load usage" });
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

    await ReviewEvent.create({
      businessSlug,
      businessName: business.businessName,
      customerName: name,
      eventType: "private_feedback_submitted"
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

/* ================= TRACKING ================= */

app.post("/track-event", async (req, res) => {
  const { businessSlug, customerName, eventType } = req.body;

  try {
    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({ success: false });
    }

    await ReviewEvent.create({
      businessSlug,
      businessName: business.businessName,
      customerName,
      eventType
    });

    res.json({ success: true });
  } catch (err) {
    console.log("Tracking error:", err);
    res.status(500).json({ success: false });
  }
});

/* ================= ADMIN ================= */

app.get("/admin-stats", requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);

  if (!user.isAdmin) {
    return res.status(403).json({ error: "No access" });
  }

  const days = parseInt(req.query.days) || 0;

  let filter = {};

  if (days > 0) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    filter.date = { $gte: date };
  }

  const events = await ReviewEvent.find(filter);

  const globalStats = {
    smsSent: 0,
    linkClicked: 0,
    goodClicks: 0,
    badClicks: 0,
    feedback: 0
  };

  const businessStats = {};

  events.forEach(e => {
    // Global
    if (e.eventType === "sms_sent") globalStats.smsSent++;
    if (e.eventType === "review_link_clicked") globalStats.linkClicked++;
    if (e.eventType === "good_review_clicked") globalStats.goodClicks++;
    if (e.eventType === "bad_review_clicked") globalStats.badClicks++;
    if (e.eventType === "private_feedback_submitted") globalStats.feedback++;

    // Per business
    if (!businessStats[e.businessSlug]) {
      businessStats[e.businessSlug] = {
        businessName: e.businessName,
        smsSent: 0,
        linkClicked: 0,
        goodClicks: 0,
        badClicks: 0,
        feedback: 0
      };
    }

    const b = businessStats[e.businessSlug];

    if (e.eventType === "sms_sent") b.smsSent++;
    if (e.eventType === "review_link_clicked") b.linkClicked++;
    if (e.eventType === "good_review_clicked") b.goodClicks++;
    if (e.eventType === "bad_review_clicked") b.badClicks++;
    if (e.eventType === "private_feedback_submitted") b.feedback++;
  });

  res.json({
    global: globalStats,
    businesses: businessStats
  });
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});