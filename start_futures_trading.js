/**
 * 合约交易自动执行脚本 - 基于马丁格尔策略
 * 作者: Claude
 * 版本: 1.0.0
 * 修改时间: 2025-04-14
 * 备注: 基于现货马丁格尔策略修改的合约交易版本
 */

const FuturesTradingApp = require('./src/futuresTradingApp');
const fs = require('fs');
const path = require('path');
const { log } = require('./src/utils/logger');

/**
 * 合约马丁格尔交易脚本
 */
async function main() {
  try {
    log('===== 启动合约马丁格尔交易系统 =====');
    log(`程序启动时间: ${new Date().toLocaleString()}`);
    
    // 添加代码识别错误位置
    try {
      log('第一阶段: 读取配置文件');
      // 读取配置文件
      const configPath = path.join(__dirname, 'backpack_futures_config.json');
      
      // 检查配置文件是否存在
      if (!fs.existsSync(configPath)) {
        log('配置文件不存在，请确保 backpack_futures_config.json 已创建', true);
        return;
      }
      
      // 读取和解析配置文件
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);
      
      log('第二阶段: 打印配置信息');
      // 打印配置信息摘要（省略敏感信息）
      log('已加载配置文件:');
      log(`- 交易币种: ${config.futures?.tradingCoin || 'BTC'}`);
      log(`- 杠杆倍数: ${config.futures?.leverage || '未设置'}`);
      log(`- 持仓方向: ${config.futures?.positionSide || 'LONG'}`);
      log(`- API密钥: ${config.api?.publicKey ? '已设置' : '未设置'}`);
      
      // 校验配置文件
      if (!config.api || !config.api.privateKey || !config.api.publicKey) {
        log('配置文件缺少API密钥信息，将使用模拟数据', true);
      }
      
      if (!config.futures || !config.futures.tradingCoin) {
        log('配置文件缺少合约交易配置，使用默认设置(BTC)', true);
        // 创建默认合约配置
        config.futures = config.futures || {};
        config.futures.tradingCoin = 'BTC';
        config.futures.maxDropPercentage = 3;
        config.futures.totalAmount = 100;
        config.futures.orderCount = 3;
        config.futures.takeProfitPercentage = 0.5;
        config.futures.leverage = 5;
        config.futures.positionSide = 'LONG';
      }
      
      log('第三阶段: 创建交易应用实例');
      // 创建并初始化交易应用
      log('创建交易应用实例...');
      
      // 先断言检查FuturesTradingApp是否已定义
      log(`FuturesTradingApp类型: ${typeof FuturesTradingApp}`);
      
      // 使用try/catch隔离应用创建过程
      let app;
      try {
        app = new FuturesTradingApp(config);
        log('交易应用实例创建成功');
      } catch (appError) {
        log(`创建交易应用实例失败: ${appError.message}`, true);
        log(`错误堆栈: ${appError.stack}`, true);
        throw appError; // 重新抛出以便上层catch捕获
      }
      
      // 添加信号处理
      process.on('SIGINT', async () => {
        log('接收到 SIGINT 信号，正在安全关闭程序...');
        await app.stop().catch(err => log(`关闭程序时出错: ${err.message}`, true));
        process.exit(0);
      });
      
      process.on('SIGTERM', async () => {
        log('接收到 SIGTERM 信号，正在安全关闭程序...');
        await app.stop().catch(err => log(`关闭程序时出错: ${err.message}`, true));
        process.exit(0);
      });
      
      // 启动交易应用
      log('初始化交易应用...');
      const initResult = await app.initialize().catch(err => {
        log(`初始化失败: ${err.message}`, true);
        return false;
      });
      
      if (!initResult) {
        log('初始化失败，程序将退出', true);
        return;
      }
      
      log('启动交易应用...');
      await app.start().catch(err => {
        log(`启动失败: ${err.message}`, true);
        throw err;
      });
      
      // 执行交易策略
      log('执行交易策略...');
      await app.executeTrade().catch(err => {
        log(`执行交易策略失败: ${err.message}`, true);
        // 不会中断程序，继续监控
      });
      
      // 启动止盈监控
      log('启动止盈监控...');
      await app.startTakeProfitMonitoring().catch(err => {
        log(`启动止盈监控失败: ${err.message}`, true);
        // 不会中断程序
      });
      
      log('===== 交易程序初始化完成 =====');
      log('程序将持续运行，监控价格并执行交易策略');
      log('使用 Ctrl+C 或 kill 命令停止程序');
      
    } catch (stageError) {
      log(`启动阶段错误: ${stageError.message}`, true);
      log(`详细错误堆栈: ${stageError.stack}`, true);
      throw stageError; // 重新抛出以便上层catch捕获
    }
    
  } catch (error) {
    log(`启动失败: ${error.message}`, true);
    log(`详细错误堆栈: ${error.stack}`, true);
    log('程序将在3秒后退出...');
    setTimeout(() => process.exit(1), 3000);
  }
}

// 执行主函数
main(); 