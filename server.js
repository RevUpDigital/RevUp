require("dotenv").config();

const path = require("path");
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const mongoose = require("mongoose");
const { Resend } = require("resend");

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

mongoose
  .connect(process.env.MONGODB_URI, { dbName: "revup" })
  .then(() => {
    console.log("MongoDB connected");
    console.log("Mongo database name:", mongoose.connection.name);
  })
  .catch((err) => console.log("MongoDB error:", err));

const businessSchema = new mongoose.Schema({
  businessName: String,
  slug: {
    type: String,
    unique: true,
    required: true,
  },
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
  date: {
    type: Date,
    default: Date.now,
  },
});

const Feedback = mongoose.model("Feedback", feedbackSchema);

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

app.post("/create-business", async (req, res) => {
  try {
    const {
      businessName,
      slug,
      email,
      googleReviewLink,
      smsMessage,
      feedbackHeading,
    } = req.body;

    const business = await Business.create({
      businessName,
      slug,
      email,
      googleReviewLink,
      smsMessage,
      feedbackHeading,
    });

    res.json({ success: true, business });
  } catch (err) {
    console.log("CREATE BUSINESS ERROR:", err);
    res.status(500).json({
      success: false,
      error: "Failed to create business",
    });
  }
});

app.get("/business/:slug", async (req, res) => {
  try {
    const business = await Business.findOne({ slug: req.params.slug });

    if (!business) {
      return res.status(404).json({
        success: false,
        error: "Business not found",
      });
    }

    res.json(business);
  } catch (err) {
    console.log("GET BUSINESS ERROR:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch business",
    });
  }
});

app.post("/send-sms", async (req, res) => {
  const { name, phone, businessSlug } = req.body;

  try {
    const business = await Business.findOne({ slug: businessSlug });

    if (!business) {
      return res.status(404).json({
        success: false,
        error: "Business not found",
      });
    }

    const reviewLink = `https://revup-26cu.onrender.com/review.html?business=${encodeURIComponent(
      business.slug
    )}&name=${encodeURIComponent(name)}`;

    const message = business.smsMessage
      .replaceAll("{{name}}", name)
      .replaceAll("{{reviewLink}}", reviewLink);

    const response = await axios.post(
      "https://rest.clicksend.com/v3/sms/send",
      {
        messages: [
          {
            body: message,
            to: phone,
          },
        ],
      },
      {
        auth: {
          username: process.env.CLICKSEND_USERNAME,
          password: process.env.CLICKSEND_API_KEY,
        },
      }
    );

    console.log("CLICKSEND RESPONSE:", response.data);

    res.json({
      success: true,
      data: response.data,
    });
  } catch (err) {
    console.log("SEND SMS ERROR:", err.response?.data || err.message);

    res.status(500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

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

    const entry = await Feedback.create({
      businessSlug: business.slug,
      businessName: business.businessName,
      name,
      feedback,
    });

    console.log("NEW FEEDBACK:", entry);

    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: business.email,
      subject: `New Customer Feedback - ${business.businessName}`,
      text: `New feedback from ${name}:\n\n${feedback}`,
    });

    console.log("EMAIL SENT");

    res.json({ success: true });
  } catch (err) {
    console.log("SAVE FEEDBACK ERROR:", err);
    res.status(500).json({
      success: false,
      error: "Failed to save feedback",
    });
  }
});

app.get("/get-feedback", async (req, res) => {
  try {
    const { businessSlug } = req.query;

    const filter = businessSlug ? { businessSlug } : {};

    const feedback = await Feedback.find(filter).sort({ date: -1 });

    res.json(feedback);
  } catch (err) {
    console.log("GET FEEDBACK ERROR:", err);
    res.status(500).json([]);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});