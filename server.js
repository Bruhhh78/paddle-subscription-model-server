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

        // 🔥 1️⃣ UPDATE PLAN FIRST (for upgrade)
        const newPriceId = event.data.items?.[0]?.price?.id;

        if (newPriceId) {
          await User.findOneAndUpdate(
            { "subscription.paddleSubscriptionId": subscriptionId },
            {
              $set: {
                "subscription.plan": newPriceId
              }
            }
          );

          console.log("Plan updated via subscription.updated:", newPriceId);
        }

        // 🔴 2️⃣ Handle cancellation scheduled
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

        // 🔵 3️⃣ Handle pause scheduled
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

        // 🔵 4️⃣ Fully paused
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

        // 🔴 5️⃣ Fully canceled
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

        // 🟢 6️⃣ Fully active
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

          console.log("Subscription active (Resumed or upgraded)");
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

        const userId = event.data.custom_data?.userId;

        // 🔥 First subscription creation (DON'T FORCE ACTIVE)
        if (userId) {

          await User.findByIdAndUpdate(userId, {
            $set: {
              "subscription.plan": priceId,
              "subscription.paddleCustomerId": customerId,
              "subscription.nextBillingDate": nextBilling
            }
          });

          console.log("Initial subscription created (status handled by subscription event)");
        }
        else {
          // 🔥 Renewal or upgrade
          await User.findOneAndUpdate(
            { "subscription.paddleSubscriptionId": subscriptionId },
            {
              $set: {
                "subscription.plan": priceId,
                "subscription.nextBillingDate": nextBilling
              }
            }
          );

          console.log("Upgrade or renewal processed");
        }
      }
      //  Handle subscription.activated
      if (event.event_type === "subscription.activated") {

        const subscriptionId = event.data.id;
        const nextBilling =
          event.data.current_billing_period?.ends_at;

        await User.findOneAndUpdate(
          { "subscription.paddleSubscriptionId": subscriptionId },
          {
            $set: {
              "subscription.status": "active",
              "subscription.nextBillingDate": nextBilling
            },
            $unset: {
              "subscription.trialEndsAt": ""
            }
          }
        );

        console.log("Trial converted to paid subscription");
      }
      // 🔵 Handle subscription.created
      if (event.event_type === "subscription.created") {

        const subscriptionId = event.data.id;
        const status = event.data.status;

        const priceId =
          event.data.items?.[0]?.price?.id || null;

        const trialEnd =
          event.data.current_billing_period?.ends_at;

        const userId = event.data.custom_data?.userId;

        if (!userId) {
          console.log("No userId in subscription.created");
          return;
        }

        await User.findByIdAndUpdate(userId, {
          $set: {
            "subscription.paddleSubscriptionId": subscriptionId,
            "subscription.plan": priceId,
            "subscription.status": status,
            "subscription.trialEndsAt":
              status === "trialing" ? trialEnd : null,
            "subscription.nextBillingDate": trialEnd
          }
        });

        console.log("Subscription created & stored correctly");
      }
      // Handle subscription.past_due
      if (event.event_type === "subscription.past_due") {
        const subscriptionId = event.data.id;

        await User.findOneAndUpdate(
          { "subscription.paddleSubscriptionId": subscriptionId },
          { $set: { "subscription.status": "past_due" } }
        );

        console.log("Subscription past_due");
      }
      // Handle transaction.past_due
      if (event.event_type === "transaction.past_due") {
        const subscriptionId = event.data.subscription_id;

        await User.findOneAndUpdate(
          { "subscription.paddleSubscriptionId": subscriptionId },
          { $set: { "subscription.status": "past_due" } }
        );

        console.log("Transaction past_due");
      }
      // 🔵 Handle subscription.trialing
      if (event.event_type === "subscription.trialing") {

        const subscriptionId = event.data.id;
        const trialEnd =
          event.data.current_billing_period?.ends_at;

        const userId = event.data.custom_data?.userId;

        if (!userId) {
          console.log("No userId in subscription.trialing");
          return;
        }

        await User.findByIdAndUpdate(userId, {
          $set: {
            "subscription.status": "trialing",
            "subscription.trialEndsAt": trialEnd,
            "subscription.nextBillingDate": trialEnd
          }
        });

        console.log("Trial started & saved correctly");
      }
      // Handle transaction.updated
      if (event.event_type === "transaction.updated") {
        console.log("Transaction updated:", event.data.id);
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

    const { priceId, discountCode } = req.body;

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
        },
        ...(discountCode && {
          discount_code: discountCode
        }),
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

//  Upgrade Subscription (Modal Way)
app.post("/upgrade-subscription", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { newPriceId } = req.body;

    const subscriptionId = req.user.subscription?.paddleSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: "No active subscription" });
    }

    console.log("🔄 Upgrading subscription:", subscriptionId);
    console.log("➡️ New price:", newPriceId);

    const response = await axios.patch(
      `https://sandbox-api.paddle.com/subscriptions/${subscriptionId}`,
      {
        items: [
          {
            price_id: newPriceId,
            quantity: 1
          }
        ],
        proration_billing_mode: "prorated_immediately"
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Upgrade success:", response.data.data.id);

    res.json({ message: "Upgrade successful" });

  } catch (error) {
    console.log("🔥 UPGRADE ERROR STATUS:", error.response?.status);
    console.log("🔥 UPGRADE ERROR DATA:", error.response?.data);
    console.log("🔥 UPGRADE ERROR MESSAGE:", error.message);

    res.status(500).json({ error: "Upgrade failed" });
  }
});

// 🔍 Preview Upgrade
app.post("/preview-upgrade", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { newPriceId } = req.body;

    const subscriptionId = req.user.subscription?.paddleSubscriptionId;

    if (!subscriptionId) {
      return res.status(400).json({ error: "No active subscription" });
    }

    const response = await axios.post(
      "https://sandbox-api.paddle.com/transactions/preview",
      {
        subscription_id: subscriptionId,
        items: [
          {
            price_id: newPriceId,
            quantity: 1
          }
        ],
        proration_billing_mode: "prorated_immediately"
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const data = response.data.data;

    res.json({
      currency: data.currency_code,
      amountDueNow: Number(data.details.totals.grand_total) / 100,
      fullPlanPrice:
        Number(data.items[0].price.unit_price.amount) / 100,
      description: data.items[0].price.description
    });

  } catch (error) {
    console.log("🔥 PREVIEW ERROR:", error.response?.data || error.message);
    res.status(500).json({ error: "Preview failed" });
  }
});

// 🔎 Validate Discount Code
app.post("/validate-coupon", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { priceId, discountCode } = req.body;

    if (!discountCode || discountCode.trim() === "") {
      return res.status(400).json({ error: "No coupon provided" });
    }

    const response = await axios.post(
      "https://sandbox-api.paddle.com/transactions/preview",
      {
        items: [
          {
            price_id: priceId,
            quantity: 1
          }
        ],
        discount_code: discountCode.trim()
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PADDLE_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const data = response.data.data;

    res.json({
      valid: true,
      newTotal: data.details.totals.grand_total / 100,
      currency: data.currency_code
    });

  } catch (error) {
    console.log("Coupon validation error:",
      JSON.stringify(error.response?.data, null, 2)
    );

    res.status(400).json({
      valid: false,
      message: "Invalid or expired coupon"
    });
  }
});

app.listen(process.env.PORT, () =>
  console.log("Server running on port 5000")
);