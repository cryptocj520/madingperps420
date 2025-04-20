/**
 * Backpack 自动化交易系统 - 模块化版本启动脚本
 * 
 * 此脚本负责启动模块化版本的交易系统，并提供自动重启功能。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 日志路径
const LOG_DIR = path.join(__dirname, 'logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 日志文件
const logFile = path.join(LOG_DIR, `trading_${new Date().toISOString().split('T')[0]}.log`);
const errorLogFile = path.join(LOG_DIR, `error_${new Date().toISOString().split('T')[0]}.log`);

// 创建日志文件流
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const errorLogStream = fs.createWriteStream(errorLogFile, { flags: 'a' });

/**
 * 记录日志
 * @param {string} message - 日志消息
 * @param {boolean} isError - 是否为错误日志
 */
function log(message, isError = false) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}`;
  
  console.log(formattedMessage);
  
  if (isError) {
    errorLogStream.write(formattedMessage + '\n');
  } else {
    logStream.write(formattedMessage + '\n');
  }
}

/**
 * 启动交易脚本
 */
function startTradingScript() {
  log('启动模块化交易系统...');
  
  // 使用 Node.js 子进程启动交易脚本
  const tradingProcess = spawn('node', ['src/index.js'], {
    stdio: 'pipe',  // 捕获输出
    detached: false // 子进程与父进程相关联
  });
  
  // 监听标准输出
  tradingProcess.stdout.on('data', (data) => {
    process.stdout.write(data);
    logStream.write(data);
  });
  
  // 监听标准错误
  tradingProcess.stderr.on('data', (data) => {
    process.stderr.write(data);
    errorLogStream.write(data);
  });
  
  // 监听脚本退出
  tradingProcess.on('exit', (code, signal) => {
    if (code === 0) {
      log('交易脚本正常退出');
    } else {
      log(`交易脚本异常退出，退出码: ${code}, 信号: ${signal}`, true);
      
      // 如果是意外退出，等待 5 秒后重新启动
      log('5秒后自动重启交易脚本...');
      setTimeout(startTradingScript, 5000);
    }
  });
  
  // 监听脚本错误
  tradingProcess.on('error', (err) => {
    log(`启动交易脚本出错: ${err.message}`, true);
  });
  
  // 保存进程引用
  currentTradingProcess = tradingProcess;
  
  return tradingProcess;
}

// 全局变量跟踪当前运行的交易进程
let currentTradingProcess = null;

/**
 * 优雅退出
 */
function gracefulShutdown() {
  log('收到终止信号，正在优雅退出...');
  
  if (currentTradingProcess) {
    // 发送SIGTERM信号给子进程
    currentTradingProcess.kill('SIGTERM');
    
    // 设置超时，确保子进程有足够的时间清理
    setTimeout(() => {
      if (currentTradingProcess) {
        log('强制终止子进程...', true);
        currentTradingProcess.kill('SIGKILL');
      }
      
      // 关闭日志流
      logStream.end();
      errorLogStream.end();
      
      process.exit(0);
    }, 10000); // 10秒超时
  } else {
    // 如果没有子进程，直接退出
    logStream.end();
    errorLogStream.end();
    process.exit(0);
  }
}

// 设置信号处理程序
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err) => {
  log(`未捕获的异常: ${err.message}`, true);
  log(err.stack, true);
  gracefulShutdown();
});

// 启动交易脚本
startTradingScript();

log('交易系统启动脚本正在运行，按 Ctrl+C 终止'); 