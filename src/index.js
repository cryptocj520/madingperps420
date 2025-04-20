const fs = require('fs');
const path = require('path');
const { Logger, log } = require('./utils/logger');
const TradingApp = require('./app');
const TimeUtils = require('./utils/timeUtils');

// 全局日志记录器
let logger;

/**
 * 读取配置文件
 * @param {string} configPath - 配置文件路径
 * @returns {Object} 配置对象
 */
function readConfig(configPath) {
  try {
    const configFile = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configFile);
  } catch (error) {
    console.error(`读取配置文件失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 应用主函数
 */
async function main() {
  // 全局应用实例
  let app = null;
  
  try {
    // 初始化日志记录器
    logger = new Logger({
      logDir: path.join(__dirname, '../logs'),
      prefix: 'backpack_trading'
    });

    // 记录程序启动
    logger.log('=== Backpack 自动化交易系统启动 ===');
    logger.log('Node.js版本: ' + process.version);
    logger.log('WorkingDir: ' + process.cwd());
    logger.log('脚本基本路径: ' + __dirname);
    
    // 读取配置文件
    const configPath = path.join(__dirname, '../backpack_trading_config.json');
    logger.log(`读取配置文件: ${configPath}`);
    const config = readConfig(configPath);
    
    // 记录基本配置信息
    logger.log(`交易币种: ${config.trading?.tradingCoin}`);
    logger.log(`总投资额: ${config.trading?.totalAmount} USDC`);
    logger.log(`订单数量: ${config.trading?.orderCount}`);
    
    // 创建交易应用
    app = new TradingApp(config, logger);
    
    // 设置SIGINT信号处理
    process.on('SIGINT', async () => {
      logger?.log('收到Ctrl+C信号，正在停止应用...');
      if (app && app.isRunning()) {
        await app.stop();
      }
      logger?.log('应用已停止，退出程序');
      process.exit(0);
    });
    
    try {
      // 初始化应用
      const initResult = await app.initialize();
      if (!initResult) {
        logger.log('初始化失败，退出程序');
        return;
      }
      
      // 启动应用
      await app.start();
      
      // 执行交易策略
      const tradeResult = await app.executeTrade();
      if (!tradeResult) {
        logger.log('交易执行失败');
      }
      
      // 持续运行，监控应用状态
      while (app.isRunning()) {
        // 记录当前状态
        if (TimeUtils.getElapsedTime(app.lastStatusLogTime) > 60000) { // 每分钟记录一次状态
          logger.log('程序运行中...');
          app.lastStatusLogTime = TimeUtils.getCurrentTime();
        }
        
        // 如果需要重置状态（由于无订单成交或触发止盈），在应用内部执行重置
        // 不需要重启程序，只需重置应用状态
        
        // 等待一段时间
        await TimeUtils.delay(5000);
      }
      
      logger.log('应用已停止运行');
    } catch (error) {
      logger.log(`程序执行出错: ${error.message}`);
      logger.log(`错误堆栈: ${error.stack}`);
      
      // 确保应用停止
      if (app && app.isRunning()) {
        await app.stop();
      }
    }
    
    logger.log('程序执行完成，退出');
  } catch (error) {
    if (logger) {
      logger.log(`主程序异常: ${error.message}`);
      logger.log(`错误堆栈: ${error.stack}`);
    } else {
      console.error(`严重错误: ${error.message}`);
      console.error(error.stack);
    }
    
    // 确保应用停止
    if (app && app.isRunning()) {
      await app.stop();
    }
  }
}

/**
 * 设置进程退出处理
 */
function setupGracefulShutdown() {
  // 创建退出处理函数
  const exitHandler = (options, exitCode) => {
    try {
      if (options.cleanup) {
        logger?.log('清理资源...');
        
        // 确保日志被刷新
        if (logger && typeof logger.flush === 'function') {
          logger.flush();
        }
      }
      
      if (exitCode || exitCode === 0) {
        logger?.log(`程序退出，退出码: ${exitCode}`);
      }
      
      // 如果需要立即退出，使用setTimeout强制在此回调执行完后立即退出
      if (options.exit) {
        setTimeout(() => {
          process.exit(0);
        }, 0);
      }
    } catch (error) {
      console.error('退出过程中发生错误:', error);
      process.exit(1);
    }
  };
  
  // 捕获不同的退出信号 - 注意SIGINT已在main函数中处理
  process.on('exit', exitHandler.bind(null, { cleanup: true }));
  process.on('SIGTERM', exitHandler.bind(null, { cleanup: true, exit: true }));
  process.on('SIGUSR1', exitHandler.bind(null, { cleanup: true, exit: true }));
  process.on('SIGUSR2', exitHandler.bind(null, { cleanup: true, exit: true }));
  process.on('uncaughtException', (error) => {
    logger?.log(`未捕获的异常: ${error.message}`);
    logger?.log(`错误堆栈: ${error.stack}`);
    process.exit(1);  // 遇到未捕获的异常直接退出
  });
}

// 设置优雅退出
setupGracefulShutdown();

// 启动主程序
main().catch(error => {
  logger?.log(`主程序未捕获异常: ${error.message}`);
  logger?.log(`错误堆栈: ${error.stack}`);
  process.exit(1);
}); 