const mongoose = require('mongoose');

const recordSchema = {
    wins: { type: Number, default: 0, min: 0 },
    losses: { type: Number, default: 0, min: 0 },
    draws: { type: Number, default: 0, min: 0 }
};

const userSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true, index: true },
    displayName: { type: String, required: true, trim: true, maxlength: 64 },
    profileImageUrl: { type: String, default: '', maxlength: 500 },
    stats: {
        chess: recordSchema,
        mutant: recordSchema,
        bot: recordSchema
    }
}, { timestamps: true });

// Die Spielersuche filtert nach displayName — ohne Index ist das ein
// Collection-Scan bei jedem Tastendruck.
userSchema.index({ displayName: 1 });

// Das Leaderboard sortiert über die aggregierten Siege.
userSchema.index({ 'stats.chess.wins': -1 });
userSchema.index({ 'stats.mutant.wins': -1 });
userSchema.index({ 'stats.bot.wins': -1 });

module.exports = mongoose.model('User', userSchema);
