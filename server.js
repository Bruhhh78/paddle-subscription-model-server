require("dotenv").config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const cors = require("cors");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const session = require("express-session");
const User = require("./models/User");

const app = express();

app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));

app.post("/paddle-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {

      const event = JSON.parse(req.body.toString());

      console.log("Webhook event:", event.event_type);

      // Handle subscription.canceled
      if (event.event_type === "subscription.canceled") {

        const subscriptionId = event.data.id;

        await User.findOneAndUpdate(
          { "subscription.paddleSubscriptionId": subscriptionId },
          {
            $set: {
              "subscription.status": "canceled"
            }
          }
        );

        console.log("Subscription canceled updated");
      }
      // Handle subscription.payment_failed
      if (event.event_type === "transaction.payment_failed") {

        const subscriptionId = event.data.subscription_id;

        await User.findOneAndUpdate(
          { "subscription.paddleSubscriptionId": subscriptionId },
          {
            $set: {
              "subscription.status": "past_due"
            }
          }
        );

        console.log("Payment failed → marked as past_due");
      }
      // Handle subscription.updated
      if (event.event_type === "subscription.updated") {

        const subscriptionId = event.data.id;
        const status = event.data.status;
        const scheduledChange = event.data.scheduled_change;

        console.log("Subscription updated status:", status);
        console.log("Scheduled change:", scheduledChange);

        // If cancellation is scheduled
        if (scheduledChange && scheduledChange.action === "cancel") {
          await User.findOneAndUpdate(
            { "subscription.paddleSubscriptionId": subscriptionId },
            {
              $set: {
                "subscription.status": "canceling"
              }
            }
          );

          console.log("Subscription marked as canceling");
        }

        // 🔵 If pause is scheduled
        if (scheduledChange && scheduledChange.action === "pause") {

          await User.findOneAndUpdate(
            { "subscription.paddleSubscriptionId": subscriptionId },
            {
              $set: {
                "subscription.status": "pausing",
                "subscription.pauseAt": scheduledChange.effective_at
              }
            }
          );

          console.log("Subscription marked as pausing");
        }

        // 🔵 Fully paused (after effective date)
        if (status === "paused") {

          await User.findOneAndUpdate(
            { "subscription.paddleSubscriptionId": subscriptionId },
            {
              $set: {
                "subscription.status": "paused",
                "subscription.pausedAt": new Date()
              }
            }
          );

          console.log("Subscription fully paused");
        }
        // If fully canceled (after period ends)
        if (status === "canceled") {

          await User.findOneAndUpdate(
            { "subscription.paddleSubscriptionId": subscriptionId },
            {
              $set: {
                "subscription.status": "canceled"
              }
            }
          );

          console.log("Subscription fully canceled");
        }

        // 🟢 Fully active (resumed or normal)
        if (status === "active" && !scheduledChange) {

          await User.findOneAndUpdate(
            { "subscription.paddleSubscriptionId": subscriptionId },
            {
              $set: {
                "subscription.status": "active"
              },
              $unset: {
                "subscription.pausedAt": "",
                "subscription.pauseAt": "",
                "subscription.cancelAt": ""
              }
            }
          );

          console.log("Subscription active (Resumed)");
        }
      }
      // Handle subscription.paused
      if (event.event_type === "subscription.paused") {

        const subscriptionId = event.data.id;

        await User.findOneAndUpdate(
          { "subscription.paddleSubscriptionId": subscriptionId },
          {
            $set: {
              "subscription.status": "paused",
              "subscription.pausedAt": new Date()
            }
          }
        );

        console.log("Subscription paused");
      }
      // Handle subscription.resumed
      if (event.event_type === "subscription.resumed") {

        const subscriptionId = event.data.id;

        await User.findOneAndUpdate(
          { "subscription.paddleSubscriptionId": subscriptionId },
          {
            $set: {
              "subscription.status": "active"
            },
            $unset: {
              "subscription.pausedAt": ""
            }
          }
        );

        console.log("Subscription resumed");
      }
      // 🔹 Handle transaction.completed
      if (event.event_type === "transaction.completed") {

        const subscriptionId = event.data.subscription_id;
        const customerId = event.data.customer_id;

        const priceId =
          event.data.items?.[0]?.price_id ||
          event.data.items?.[0]?.price?.id ||
          null;

        const nextBilling =
          event.data.billing_period?.ends_at || null;

        // 🔥 READ USER ID DIRECTLY FROM PADDLE
        const userId = event.data.custom_data?.userId;

        console.log("Webhook userId:", userId);

        if (!userId) {
          console.log("No userId in custom_data");
          return res.status(200).send("No userId");
        }

        await User.findByIdAndUpdate(userId, {
          $set: {
            "subscription.status": "active",
            "subscription.plan": priceId,
            "subscription.paddleSubscriptionId": subscriptionId,
            "subscription.paddleCustomerId": customerId,
            "subscription.nextBillingDate": nextBilling
          }
        });

        console.log("User updated safely via custom_data");
      }
      res.status(200).send("OK");

    } catch (error) {
      console.log("Webhook error:", error);
      res.status(200).send("Error handled");
    }
  }
);

app.use(express.json());

app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: "lax"
  }
}));

app.use(passport.initialize());
app.use(passport.session());


mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.log(err));

// Configure Google Strategy 
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "/auth/google/callback"
},
  async (accessToken, refreshToken, profile, done) => {

    try {
      let user = await User.findOne({ googleId: profile.id });

      if (!user) {
        user = await User.create({
          googleId: profile.id,
          name: profile.displayName,
          email: profile.emails[0].value,
          picture: profile.photos[0].value
        });
      }

      return done(null, user);

    } catch (error) {
      return done(error, null);
    }
  }));

// Serialize / Deserialize

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  const user = await User.findById(id);
  done(null, user);
});

// Auth routes 
// Start Google login
app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// Callback
app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "http://localhost:5173"
  }),
  (req, res) => {
    res.redirect("http://localhost:5173/dashboard");
  }
);

// Get logged-in user
app.get("/auth/user", (req, res) => {
  res.json(req.user || null);
});

// Logout
app.get("/auth/logout", (req, res) => {
  req.logout(() => {
    res.redirect("http://localhost:5173");
  });
});

// 🔹 Create Paddle Checkout
app.post("/create-checkout", async (req, res) => {
  try {

    if (!req.user) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    const { priceId } = req.body;

    const response = await axios.post(
      "https://sandbox-api.paddle.com/transactions",
      {
        items: [
          {
            price_id: priceId,
            quantity: 1
          }
        ],
        customer: {
          email: req.user.email
        },
        custom_data: {
          userId: req.user._id.toString()
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const transactionId = response.data.data.id;
    const customerId = response.data.data.customer_id;

    await User.findByIdAndUpdate(req.user._id, {
      $set: {
        "subscription.transactionId": transactionId,
        "subscription.paddleCustomerId": customerId
      }
    });

    res.json({ transactionId });

  } catch (error) {
    console.log("PADDLE ERROR:", error.response?.data || error.message);
    res.status(500).json({ error: "Checkout creation failed" });
  }
});

// 🔴 Cancel Subscription (User Dashboard)
app.post("/cancel-subscription", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const subscriptionId = req.user.subscription?.paddleSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: "No active subscription" });
    }

    console.log("Cancel subscriptionId:", subscriptionId);

    await axios.post(
      `https://sandbox-api.paddle.com/subscriptions/${subscriptionId}/cancel`,
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ message: "Cancellation requested" });

  } catch (error) {
    console.log("Cancel FULL error:");
    console.log("Status:", error.response?.status);
    console.log("Data:", JSON.stringify(error.response?.data, null, 2));
    res.status(500).json({ error: "Cancellation failed" });
  }
});

// 🔵 Pause Subscription
app.post("/pause-subscription", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const subscriptionId = req.user.subscription?.paddleSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: "No active subscription" });
    }

    await axios.post(
      `https://sandbox-api.paddle.com/subscriptions/${subscriptionId}/pause`,
      {
        effective_from: "immediately"
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ message: "Pause requested" });

  } catch (error) {
    console.log("Pause error:", error.response?.data || error.message);
    res.status(500).json({ error: "Pause failed" });
  }
});

// 🟢 Resume Subscription
app.post("/resume-subscription", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const subscriptionId = req.user.subscription?.paddleSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: "No subscription found" });
    }

    await axios.post(
      `https://sandbox-api.paddle.com/subscriptions/${subscriptionId}/resume`,
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ message: "Resume requested" });

  } catch (error) {
    console.log("Resume error:", error.response?.data || error.message);
    res.status(500).json({ error: "Resume failed" });
  }
});

app.listen(process.env.PORT, () =>
  console.log("Server running on port 5000")
);