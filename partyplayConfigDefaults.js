var config = {};
config.backendServices = ['gmusic'];
config.songCachePath = process.env.HOME + '/.partyplay/songCache';
config.searchResultCnt = 10;
config.badVotePercent = 0.67;
config.songDelayMs = 1000;
module.exports = config;