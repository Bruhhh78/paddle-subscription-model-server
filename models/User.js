const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  googleId: String,
  name: String,
  email: String,
  picture: String,

  subscription: {
    plan: { type: String, default: null },
    status: { type: String, default: "inactive" },

    paddleSubscriptionId: { type: String, default: null },
    paddleCustomerId: { type: String, default: null },
    transactionId: { type: String, default: null },

    nextBillingDate: { type: Date, default: null },
    trialEndsAt: Date,

    cancelAt: { type: Date, default: null },
    pauseAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null }
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("User", userSchema);