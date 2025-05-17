const NodeCache = require('node-cache');

// Configure cache with TTL and memory limits
const attendanceCache = new NodeCache({
  stdTTL: process.env.CACHE_TTL || 3600, // 1 hour default TTL
  checkperiod: 120, // Check for expired keys every 2 minutes
  maxKeys: process.env.CACHE_MAX_KEYS || 1000, // Maximum number of keys in cache
  useClones: false, // Don't clone objects for better performance
  deleteOnExpire: true, // Automatically delete expired items
});

// Cache statistics monitoring
setInterval(() => {
  const stats = attendanceCache.getStats();
  console.log('Cache Stats:', {
    hits: stats.hits,
    misses: stats.misses,
    keys: stats.keys,
    ksize: stats.ksize,
    vsize: stats.vsize
  });
}, 300000); // Log every 5 minutes

// Handle cache errors
attendanceCache.on('error', (err) => {
  console.error('Cache error:', err);
});

module.exports = { attendanceCache }; 