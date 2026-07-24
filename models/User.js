const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    profileImageUrl: { type: String },
    stats: {
        chess: { wins: { type: Number, default: 0 }, losses: { type: Number, default: 0 } },
        mutant: { wins: { type: Number, default: 0 }, losses: { type: Number, default: 0 } },
        bot: { wins: { type: Number, default: 0 }, losses: { type: Number, default: 0 } }
    }
});

module.exports = mongoose.model('User', userSchema);
