const NodeCache = require('node-cache');

// Create attendance cache with optimized settings for Render
const attendanceCache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL) || 3600, // 1 hour default
  checkperiod: 600, // Check for expired keys every 10 minutes
  useClones: false, // Don't clone objects for better performance
  maxKeys: parseInt(process.env.CACHE_MAX_KEYS) || 1000, // Limit cache size
  deleteOnExpire: true,
  enableLegacyCallbacks: false,
  forceString: false
});

// Create a separate cache for course data with longer TTL
const courseCache = new NodeCache({
  stdTTL: parseInt(process.env.COURSE_CACHE_TTL) || 7200, // 2 hours default
  checkperiod: 600,
  useClones: false,
  maxKeys: parseInt(process.env.COURSE_CACHE_MAX_KEYS) || 500,
  deleteOnExpire: true,
  enableLegacyCallbacks: false,
  forceString: false
});

// Cache statistics
const getCacheStats = () => {
  return {
    attendance: {
      keys: attendanceCache.keys().length,
      hits: attendanceCache.getStats().hits,
      misses: attendanceCache.getStats().misses,
      ksize: attendanceCache.getStats().ksize,
      vsize: attendanceCache.getStats().vsize
    },
    course: {
      keys: courseCache.keys().length,
      hits: courseCache.getStats().hits,
      misses: courseCache.getStats().misses,
      ksize: courseCache.getStats().ksize,
      vsize: courseCache.getStats().vsize
    }
  };
};

// Cache cleanup function
const cleanupCache = () => {
  const beforeAttendance = attendanceCache.keys().length;
  const beforeCourse = courseCache.keys().length;
  
  attendanceCache.flushStats();
  courseCache.flushStats();
  
  console.log(`Cache cleanup: Attendance (${beforeAttendance} keys), Course (${beforeCourse} keys)`);
};

// Periodic cleanup (every 30 minutes)
const cleanupInterval = setInterval(cleanupCache, 30 * 60 * 1000);

// Enhanced cache functions with error handling
const cacheHelpers = {
  // Get from attendance cache with fallback
  getAttendance: (key) => {
    try {
      return attendanceCache.get(key);
    } catch (error) {
      console.error('Error getting attendance cache:', error);
      return null;
    }
  },

  // Set attendance cache with error handling
  setAttendance: (key, value, ttl = null) => {
    try {
      if (ttl) {
        return attendanceCache.set(key, value, ttl);
      }
      return attendanceCache.set(key, value);
    } catch (error) {
      console.error('Error setting attendance cache:', error);
      return false;
    }
  },

  // Get from course cache with fallback
  getCourse: (key) => {
    try {
      return courseCache.get(key);
    } catch (error) {
      console.error('Error getting course cache:', error);
      return null;
    }
  },

  // Set course cache with error handling
  setCourse: (key, value, ttl = null) => {
    try {
      if (ttl) {
        return courseCache.set(key, value, ttl);
      }
      return courseCache.set(key, value);
    } catch (error) {
      console.error('Error setting course cache:', error);
      return false;
    }
  },

  // Delete from both caches
  deleteKey: (key) => {
    try {
      attendanceCache.del(key);
      courseCache.del(key);
      return true;
    } catch (error) {
      console.error('Error deleting cache key:', error);
      return false;
    }
  },

  // Clear all caches
  clearAll: () => {
    try {
      attendanceCache.flushAll();
      courseCache.flushAll();
      return true;
    } catch (error) {
      console.error('Error clearing caches:', error);
      return false;
    }
  }
};

// Event listeners for cache events
attendanceCache.on('expired', (key, value) => {
  console.log(`Attendance cache key expired: ${key}`);
});

courseCache.on('expired', (key, value) => {
  console.log(`Course cache key expired: ${key}`);
});

attendanceCache.on('set', (key, value) => {
  console.log(`Attendance cache set: ${key}`);
});

courseCache.on('set', (key, value) => {
  console.log(`Course cache set: ${key}`);
});

// Graceful cleanup on shutdown
const gracefulCacheShutdown = () => {
  console.log('Cleaning up caches...');
  clearInterval(cleanupInterval);
  attendanceCache.close();
  courseCache.close();
};

process.on('SIGTERM', gracefulCacheShutdown);
process.on('SIGINT', gracefulCacheShutdown);

module.exports = {
  attendanceCache,
  courseCache,
  getCacheStats,
  cleanupCache,
  cacheHelpers
};