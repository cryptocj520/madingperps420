/**
 * 时间工具类 - 负责处理时间相关功能
 */
class TimeUtils {
  /**
   * 获取当前时间的格式化字符串
   * @param {string} format - 格式化类型 (default: 'full')
   * @returns {string} 格式化的时间字符串
   */
  static getCurrentTime(format = 'full') {
    const now = new Date();
    
    switch (format) {
      case 'date':
        return now.toISOString().split('T')[0];
      case 'time':
        return now.toLocaleTimeString();
      case 'compact':
        return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
      case 'timestamp':
        return now.getTime().toString();
      case 'full':
      default:
        return now.toLocaleString();
    }
  }
  
  /**
   * 获取运行时间的格式化字符串
   * @param {Date|number} startTime - 开始时间
   * @param {Date|number} endTime - 结束时间（默认为当前时间）
   * @returns {string} 格式化的时间差字符串
   */
  static getElapsedTime(startTime, endTime = new Date()) {
    // 转换为Date对象
    const start = startTime instanceof Date ? startTime : new Date(startTime);
    const end = endTime instanceof Date ? endTime : new Date(endTime);
    
    // 计算时间差（毫秒）
    const elapsedMs = end - start;
    
    // 计算小时、分钟和秒
    const seconds = Math.floor(elapsedMs / 1000) % 60;
    const minutes = Math.floor(elapsedMs / (1000 * 60)) % 60;
    const hours = Math.floor(elapsedMs / (1000 * 60 * 60));
    
    return `${hours}小时${minutes}分${seconds}秒`;
  }
  
  /**
   * 创建延迟Promise
   * @param {number} ms - 延迟毫秒数
   * @returns {Promise} 延迟Promise
   */
  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 计算到期时间
   * @param {number} minutes - 分钟数
   * @returns {Date} 到期时间
   */
  static getExpiryTime(minutes) {
    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + minutes);
    return expiry;
  }
  
  /**
   * 检查指定时间是否已到期
   * @param {Date|number} time - 要检查的时间
   * @returns {boolean} 是否已到期
   */
  static isExpired(time) {
    const checkTime = time instanceof Date ? time : new Date(time);
    return new Date() > checkTime;
  }
  
  /**
   * 获取剩余时间（分钟）
   * @param {Date|number} targetTime - 目标时间
   * @returns {number} 剩余分钟数
   */
  static getRemainingMinutes(targetTime) {
    const target = targetTime instanceof Date ? targetTime : new Date(targetTime);
    const now = new Date();
    const diffMs = target - now;
    
    if (diffMs <= 0) return 0;
    
    return Math.ceil(diffMs / (1000 * 60));
  }
  
  /**
   * 格式化持续时间（秒）
   * @param {number} seconds - 秒数
   * @returns {string} 格式化的持续时间
   */
  static formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    
    if (mins === 0) {
      return `${secs}秒`;
    } else {
      return `${mins}分${secs}秒`;
    }
  }
}

module.exports = TimeUtils; 