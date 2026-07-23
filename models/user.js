const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    profileImageUrl: { type: String }
});
module.exports = mongoose.model('User', userSchema);
