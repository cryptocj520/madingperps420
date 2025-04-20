const fs = require('fs');
const path = require('path');

// 日志级别定义
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4
};

/**
 * 日志工具类 - 负责记录日志到控制台和文件
 */
class Logger {
  /**
   * 构造函数
   * @param {Object} options - 日志选项
   * @param {string} options.logDir - 日志目录
   * @param {string} options.prefix - 日志文件前缀
   * @param {number} options.logLevel - 日志级别
   * @param {number} options.sampleRate - 日志采样率(0-1)
   */
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.prefix = options.prefix || 'trading';
    this.logLevel = options.logLevel !== undefined ? options.logLevel : LOG_LEVELS.INFO;
    this.sampleRate = options.sampleRate !== undefined ? options.sampleRate : 1.0;
    
    // 确保日志目录存在
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }
  
  /**
   * 获取当前日期字符串，格式为YYYY-MM-DD
   * @returns {string} 日期字符串
   */
  getDateString() {
    return new Date().toISOString().split('T')[0];
  }
  
  /**
   * 记录日志
   * @param {string} message - 日志消息
   * @param {boolean} isError - 是否为错误日志
   * @param {boolean} displayOnConsole - 是否在控制台显示
   * @param {number} level - 日志级别
   */
  log(message, isError = false, displayOnConsole = true, level = LOG_LEVELS.INFO) {
    try {
      // 确保this和this.logLevel存在
      const logLevel = this && typeof this.logLevel !== 'undefined' ? this.logLevel : LOG_LEVELS.INFO;
      
      // 如果消息级别低于设置的级别，忽略此消息
      if (level < logLevel) {
        return;
      }
      
      // 应用采样率 - 对于非错误日志，根据采样率决定是否记录
      const sampleRate = this && typeof this.sampleRate !== 'undefined' ? this.sampleRate : 1.0;
      if (!isError && level < LOG_LEVELS.ERROR && Math.random() > sampleRate) {
        return;
      }
      
      const timestamp = new Date().toLocaleString();
      const logMessage = `[${timestamp}] ${message}`;
      
      // 根据参数决定是否在控制台显示
      if (displayOnConsole) {
        if (isError) {
          console.error(logMessage);
        } else {
          console.log(logMessage);
        }
      }
      
      // 确保logDir存在
      const logDir = this && this.logDir ? this.logDir : path.join(process.cwd(), 'logs');
      
      // 确保日志目录存在
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      // 获取当前日期和前缀
      const date = this && typeof this.getDateString === 'function' ? this.getDateString() : new Date().toISOString().split('T')[0];
      const prefix = this && this.prefix ? this.prefix : 'trading';
      
      // 生成普通日志文件路径
      const logFile = path.join(logDir, `${prefix}_${date}.log`);
      
      // 写入普通日志
      fs.appendFileSync(
        logFile, 
        logMessage + '\n', 
        { encoding: 'utf8' }
      );
      
      // 如果是错误，还要写入错误日志
      if (isError) {
        const errorLogFile = path.join(logDir, `error_${date}.log`);
        fs.appendFileSync(
          errorLogFile,
          logMessage + '\n',
          { encoding: 'utf8' }
        );
      }
    } catch (err) {
      // 如果日志功能本身出错，不应该影响主程序
      // 使用console直接输出，避免循环调用
      console.error(`Logger错误: ${err.message}`);
      console.log(message); // 仍然输出原始消息
    }
  }
  
  /**
   * 只记录到日志文件，不在控制台显示
   * @param {string} message - 日志消息
   * @param {boolean} isError - 是否为错误日志
   * @param {number} level - 日志级别
   */
  logToFile(message, isError = false, level = LOG_LEVELS.DEBUG) {
    this.log(message, isError, false, level);
  }
  
  /**
   * 记录调试级别日志
   * @param {string} message - 日志消息
   * @param {boolean} displayOnConsole - 是否在控制台显示
   */
  debug(message, displayOnConsole = false) {
    this.log(message, false, displayOnConsole, LOG_LEVELS.DEBUG);
  }
  
  /**
   * 记录信息级别日志
   * @param {string} message - 日志消息
   */
  info(message) {
    this.log(message, false, true, LOG_LEVELS.INFO);
  }
  
  /**
   * 记录警告级别日志
   * @param {string} message - 日志消息
   */
  warn(message) {
    this.log(message, false, true, LOG_LEVELS.WARN);
  }
  
  /**
   * 记录错误级别日志
   * @param {string} message - 日志消息
   */
  error(message) {
    this.log(message, true, true, LOG_LEVELS.ERROR);
  }
  
  /**
   * 设置日志级别
   * @param {number} level - 日志级别
   */
  setLogLevel(level) {
    if (level >= LOG_LEVELS.DEBUG && level <= LOG_LEVELS.NONE) {
      this.logLevel = level;
    }
  }
  
  /**
   * 设置采样率
   * @param {number} rate - 采样率(0-1)
   */
  setSampleRate(rate) {
    if (rate >= 0 && rate <= 1) {
      this.sampleRate = rate;
    }
  }
  
  /**
   * 创建交易周期日志文件
   * @returns {string} 周期日志文件路径
   */
  createCycleLogFile() {
    const date = this.getDateString();
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
    const cycleLogFile = path.join(this.logDir, `auto_trading_cycle_${date}_${timestamp}.log`);
    return cycleLogFile;
  }
  
  /**
   * 记录订单到交易周期日志
   * @param {string} logFile - 周期日志文件路径
   * @param {Object} order - 订单信息
   * @param {Object} config - 配置信息
   */
  logOrderToCycle(logFile, order, config) {
    try {
      if (!logFile) return;
      
      const timestamp = new Date().toLocaleString();
      const logEntry = {
        timestamp,
        orderId: order.id,
        symbol: order.symbol || config.symbol,
        price: order.price,
        quantity: order.quantity,
        status: order.status,
        side: order.side,
        filled: order.status === 'Filled'
      };
      
      fs.appendFileSync(
        logFile,
        JSON.stringify(logEntry) + '\n',
        { encoding: 'utf8' }
      );
    } catch (error) {
      this.log(`记录订单到周期日志失败: ${error.message}`, true, false);
    }
  }
  
  /**
   * 专门记录API错误的方法
   * @param {Error} error - 错误对象
   * @param {string} context - 错误上下文描述
   * @param {Object} params - API调用参数
   */
  logApiError(error, context, params = {}) {
    // 构建基本错误信息
    let messages = [];
    messages.push(`[API错误] ${context}: ${error.message}`);
    
    // 记录API调用参数
    if (Object.keys(params).length > 0) {
      messages.push(`请求参数: ${JSON.stringify(params)}`);
    }
    
    // 处理响应错误
    if (error.response) {
      const { status, statusText, data } = error.response;
      messages.push(`响应状态: ${status} (${statusText || 'No status text'})`);
      
      // 记录响应数据
      if (data) {
        messages.push(`响应数据: ${JSON.stringify(data)}`);
        
        // 提取错误信息
        if (data.message) messages.push(`错误消息: ${data.message}`);
        if (data.code) messages.push(`错误代码: ${data.code}`);
        if (data.error) messages.push(`错误详情: ${JSON.stringify(data.error)}`);
      }
    }
    
    // 记录请求信息
    if (error.request) {
      const { method, path, headers } = error.request;
      messages.push(`请求方法: ${method || 'N/A'}`);
      messages.push(`请求URL: ${path || 'N/A'}`);
    }
    
    // 记录错误堆栈
    if (error.stack) {
      messages.push(`堆栈: ${error.stack}`);
    }
    
    // 将所有信息写入日志
    messages.forEach(msg => this.log(msg, true, true, LOG_LEVELS.ERROR));
    
    // 同时写入错误专用日志文件
    const date = this.getDateString();
    const apiErrorLogFile = path.join(this.logDir, `api_error_${date}.log`);
    
    fs.appendFileSync(
      apiErrorLogFile,
      `\n--- API错误 [${new Date().toISOString()}] ---\n${messages.join('\n')}\n`,
      { encoding: 'utf8' }
    );
  }
  
  /**
   * 确保所有日志被写入文件系统
   */
  flush() {
    const message = '正在刷新日志缓冲区...';
    const timestamp = new Date().toLocaleString();
    const logMessage = `[${timestamp}] ${message}`;
    
    // 获取当前日期
    const date = this.getDateString();
    
    // 生成普通日志文件路径
    const logFile = path.join(this.logDir, `${this.prefix}_${date}.log`);
    
    // 写入普通日志
    fs.appendFileSync(
      logFile, 
      logMessage + '\n', 
      { encoding: 'utf8' }
    );
  }
}

// 创建默认实例
const defaultLogger = new Logger({
  logLevel: LOG_LEVELS.INFO,
  sampleRate: 0.3  // 只记录30%的非错误日志
});

/**
 * 全局日志函数 - 可以安全地在任何地方调用
 * @param {string} message - 日志消息
 * @param {boolean} isError - 是否为错误日志
 * @param {boolean} displayOnConsole - 是否在控制台显示
 */
function log(message, isError = false, displayOnConsole = true) {
  try {
    // 使用默认logger实例
    defaultLogger.log(message, isError, displayOnConsole);
  } catch (err) {
    // 如果defaultLogger.log出错，回退到基本日志记录
    try {
      const timestamp = new Date().toLocaleString();
      const logMessage = `[${timestamp}] ${message}`;
      
      // 显示在控制台
      if (displayOnConsole) {
        if (isError) {
          console.error(logMessage);
        } else {
          console.log(logMessage);
        }
      }
      
      // 写入文件
      const logDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      const date = new Date().toISOString().split('T')[0];
      const logFile = path.join(logDir, `trading_${date}.log`);
      
      fs.appendFileSync(logFile, logMessage + '\n', { encoding: 'utf8' });
      
      if (isError) {
        const errorLogFile = path.join(logDir, `error_${date}.log`);
        fs.appendFileSync(errorLogFile, logMessage + '\n', { encoding: 'utf8' });
      }
    } catch (fileError) {
      // 最后的回退：至少在控制台输出
      console.error(`日志系统错误: ${err.message}`);
      console.log(message);
    }
  }
}

module.exports = {
  Logger,
  LOG_LEVELS,
  log,
  defaultLogger
}; 