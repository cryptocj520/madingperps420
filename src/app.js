const BackpackService = require('./services/backpackService');
const PriceMonitor = require('./core/priceMonitor');
const TradingStrategyModule = require('./core/tradingStrategy');
const OrderManagerService = require('./core/orderManager');
const { Order, OrderManager } = require('./models/Order');
const TradeStats = require('./models/TradeStats');
const { log, defaultLogger } = require('./utils/logger');
const TimeUtils = require('./utils/timeUtils');
const Formatter = require('./utils/formatter');

/**
 * 应用程序类 - 协调各个组件工作
 */
class TradingApp {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   */
  constructor(config) {
    this.config = config;
    this.logger = defaultLogger;
    
    // 初始化组件
    this.backpackService = new BackpackService(config, this.logger);
    this.tradingStrategy = new TradingStrategyModule(this.logger, this.config);
    this.orderManager = new OrderManager();
    this.tradeStats = new TradeStats();
    
    // 初始化订单管理服务
    this.orderManagerService = new OrderManagerService(config, this.backpackService);
    
    // 初始化价格监控器
    this.priceMonitor = new PriceMonitor({
      config: config,
      onPriceUpdate: this.handlePriceUpdate.bind(this),
      logger: this.logger
    });
    
    // 应用状态
    this.running = false;
    this.symbol = null;
    this.tradingCoin = null;
    this.currentPriceInfo = null;
    this.monitoringInterval = null;
    this.scriptStartTime = new Date();
    this.cycleLogFile = null;
    this.lastDisplayTime = 0;
    this.displayInitialized = false;
    this.takeProfitTriggered = false;
    this.lastPriceLogTime = null;
    this.lastLoggedPrice = null;
    this.lastRelativePriceLogTime = null;
  }
  
  /**
   * 处理价格更新
   * @param {Object} priceInfo - 价格信息
   */
  handlePriceUpdate(priceInfo) {
    // 确保从WebSocket接收到的价格能够被更新到应用状态
    this.currentPriceInfo = priceInfo;
    
    // 只有在有成交订单且均价大于0时才计算价格涨幅和显示
    if (priceInfo && this.tradeStats.filledOrders > 0 && this.tradeStats.averagePrice > 0) {
      const priceIncrease = ((priceInfo.price - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
      this.currentPriceInfo.increase = priceIncrease;
      
      // 如果价格变化大，记录到终端
      if (Math.abs(priceIncrease) > 0.1) {
        // 新增对上次日志时间的检查，限制不必要的日志输出
        const now = Date.now();
        const logThrottleTime = 10000; // 10秒内不重复输出相似价格变化
        
        // 只有当距离上一次日志超过阈值时间，才输出新日志
        if (!this.lastRelativePriceLogTime || (now - this.lastRelativePriceLogTime) > logThrottleTime) {
          const direction = priceIncrease >= 0 ? '上涨' : '下跌';
          log(`相对均价${direction}: ${Math.abs(priceIncrease).toFixed(2)}% (当前: ${priceInfo.price.toFixed(2)}, 均价: ${this.tradeStats.averagePrice.toFixed(2)})`);
          this.lastRelativePriceLogTime = now;
        }
      }
      
      // 检查是否达到止盈条件 - 只有当有成交的买单时才检查止盈
      if (this.running && !this.takeProfitTriggered) {
        const takeProfitPercentage = this.config.trading.takeProfitPercentage;
        
        // 检查是否达到止盈条件
        const takeProfitReached = this.tradingStrategy.isTakeProfitTriggered(
          priceInfo.price, 
          this.tradeStats.averagePrice, 
          takeProfitPercentage
        );
        
        if (takeProfitReached) {
          log(`\n===== 止盈条件达成！=====`);
          log(`当前价格: ${priceInfo.price} USDC`);
          log(`平均买入价: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
          log(`涨幅: ${priceIncrease.toFixed(2)}% >= 止盈点: ${takeProfitPercentage}%`);
          log('准备卖出获利...');
          
          // 设置止盈触发标志，避免重复触发
          this.takeProfitTriggered = true;
          
          // 执行止盈操作
          this.executeTakeProfit();
        }
      }
    } else if (priceInfo && (!this.tradeStats.filledOrders || this.tradeStats.filledOrders <= 0)) {
      // 没有成交订单时，不显示相对均价信息
      this.currentPriceInfo.increase = 0;
    }
    
    // 更新显示（限制频率）
    const now = Date.now();
    if (!this.lastDisplayTime || (now - this.lastDisplayTime) > 15000) {
      this.displayAccountInfo();
      this.lastDisplayTime = now;
    }
  }
  
  /**
   * 执行止盈操作
   */
  async executeTakeProfit() {
    try {
      // 先取消所有未成交的买单
      await this.cancelAllOrders();
      
      // 执行卖出操作
      await this.sellAllPosition();
      
      // 清除监控间隔
      if (this.monitoringInterval) {
        clearInterval(this.monitoringInterval);
        this.monitoringInterval = null;
      }
      
      // 检查是否需要在止盈后自动重置
      if (this.config.actions.restartAfterTakeProfit) {
        log('\n===== 止盈后自动重置应用状态 =====');
        
        // 先停止价格监控，确保WebSocket连接正确关闭
        log('停止价格监控和WebSocket连接...');
        this.priceMonitor.stopMonitoring();
        
        // 确保WebSocket连接被显式关闭
        if (this.priceMonitor.wsManager) {
          this.priceMonitor.wsManager.closeAllConnections();
          log('已关闭所有WebSocket连接');
        }
        
        // 重置应用状态
        this.resetAppState();
        
        // 重新初始化应用 - 初始化时添加标记，避免start()中再次调用initialize()
        log('正在重新初始化交易环境...');
        await this.initialize();
        
        // 重新启动应用，传递skipInitialize参数为true，避免重复初始化
        await this.start(true);
        
        // 重新执行交易策略
        await this.executeTrade();
      }
    } catch (error) {
      log(`执行止盈操作时出错: ${error.message}`, true);
    }
  }
  
  /**
   * 初始化交易环境
   */
  async initialize() {
    try {
      log('正在初始化交易环境...');
      
      // 读取并设置配置
      this.config = this.config || {};
      this.tradingCoin = this.config.trading?.tradingCoin || this.config.tradingCoin || 'BTC';
      this.symbol = `${this.tradingCoin}_USDC`;
      this.apiSymbol = this.symbol;  // 使用相同的格式，不需要转换
      
      log(`交易对: ${this.apiSymbol}`);
      
      // 初始化服务和管理器
      // TimeUtils是静态类，不需要实例化
      this.orderManager = new OrderManager(this.logger);
      
      // 确保传递logger给所有服务
      this.backpackService = new BackpackService(this.config, this.logger);
      this.priceMonitor = new PriceMonitor({
        config: this.config,
        onPriceUpdate: this.handlePriceUpdate.bind(this),
        logger: this.logger
      });
      this.tradingStrategy = new TradingStrategyModule(this.logger, this.config);
      
      log('所有服务初始化完成');
      
      // 记录应用启动时间
      this.startTime = new Date();
      log(`程序启动时间: ${this.startTime.toLocaleString()}`);
      
      // 初始化状态变量
      this.running = false;
      this.lastTradeTime = new Date();
      this.lastStatusLogTime = new Date();
      this.lastDisplayTime = 0;
      
      // 清空交易相关的状态
      this.takeProfitTriggered = false;
      this.currentPriceInfo = null;
      this.usdcBalance = 0;
      this.usdcTotal = 0;
      this.coinBalance = 0;
      this.coinTotal = 0;
      
      // 完全重置交易统计和订单管理器
      if (this.tradeStats) {
        this.tradeStats.reset();
      } else {
        this.tradeStats = new TradeStats();
      }
      this.orderManager.reset();
      
      // 设置价格监控回调
      this.priceMonitor.onPriceUpdate = (priceInfo) => this.handlePriceUpdate(priceInfo);
      
      // 尝试获取初始价格
      try {
        const ticker = await this.backpackService.getTicker(this.apiSymbol);
        if (ticker && ticker.lastPrice) {
          log(`初始价格: ${ticker.lastPrice} USDC (来源: API)`);
          this.currentPrice = parseFloat(ticker.lastPrice);
        } else {
          log('警告: 无法获取初始价格');
        }
      } catch (error) {
        log(`获取初始价格失败: ${error.message}`);
      }
      
      return true;
    } catch (error) {
      log(`初始化失败: ${error.message}`);
      return false;
    }
  }
  
  /**
   * 启动交易应用
   */
  async start(skipInitialize = false) {
    try {
      if (this.running) {
        log('应用程序已经在运行中');
        return false;
      }
      
      // 初始化环境
      if (!skipInitialize) {
        const initialized = await this.initialize();
        if (!initialized) {
          log('初始化失败，应用程序无法启动', true);
          return false;
        }
      }
      
      // 启动价格监控
      this.priceMonitor.startMonitoring(this.symbol);
      
      // 添加轮询检查机制，每5秒检查一次价格数据
      // 明确价格来源优先级: WebSocket > WebSocketManager存储价格 > API轮询
      this.priceCheckInterval = setInterval(() => {
        try {
          // 明确数据来源优先级标记
          let priceSource = '';
          let priceData = null;
          
          // 直接从priceMonitor获取价格数据 (最高优先级)
          if (this.priceMonitor.currentPrice > 0) {
            priceData = {
              price: this.priceMonitor.currentPrice,
              symbol: this.symbol,
              source: 'WebSocket',
              updateTime: this.priceMonitor.lastUpdateTime || Date.now()
            };
            priceSource = 'priceMonitor';
          }
          // 如果priceMonitor没有价格数据，但WebSocketManager有 (第二优先级)
          else if (this.priceMonitor.wsManager && 
                  this.priceMonitor.wsManager.lastPriceData && 
                  this.priceMonitor.wsManager.lastPriceData.price > 0) {
            
            const wsData = this.priceMonitor.wsManager.lastPriceData;
            priceData = {
              price: wsData.price,
              symbol: wsData.symbol || this.symbol,
              source: 'WebSocketManager',
              updateTime: wsData.time || Date.now()
            };
            priceSource = 'wsManager';
          }
          
          // 如果有价格数据，则更新应用状态
          if (priceData) {
            // 记录价格数据但减少日志频率 - 每30秒记录一次或价格变化超过0.5%
            const now = Date.now();
            if (!this.lastPriceLogTime || (now - this.lastPriceLogTime > 30000) || 
                (this.lastLoggedPrice && Math.abs((priceData.price - this.lastLoggedPrice) / this.lastLoggedPrice) >= 0.005)) {
              // 仅在日志中标记数据来源，不重复日志
              log(`轮询获取价格: ${priceData.price} USDC (来源: ${priceSource})`);
              this.lastPriceLogTime = now;
              this.lastLoggedPrice = priceData.price;
            }
            
            // 更新当前价格信息
            this.currentPriceInfo = priceData;
            
            // 只有在有成交订单且均价大于0时才计算涨跌幅
            if (this.tradeStats.filledOrders > 0 && this.tradeStats.averagePrice > 0) {
              const priceIncrease = ((priceData.price - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
              this.currentPriceInfo.increase = priceIncrease;
              
              // 添加相对均价变化的日志节流
              if (Math.abs(priceIncrease) > 0.1) {
                const now = Date.now();
                const logThrottleTime = 10000; // 10秒内不重复输出相似价格变化
                
                // 只有当距离上一次日志超过阈值时间，才输出新日志
                if (!this.lastRelativePriceLogTime || (now - this.lastRelativePriceLogTime) > logThrottleTime) {
                  const direction = priceIncrease >= 0 ? '上涨' : '下跌';
                  log(`轮询检测到相对均价${direction}: ${Math.abs(priceIncrease).toFixed(2)}% (当前: ${priceData.price.toFixed(2)}, 均价: ${this.tradeStats.averagePrice.toFixed(2)})`);
                  this.lastRelativePriceLogTime = now;
                }
              }
            } else {
              // 没有成交订单时，不显示相对均价信息
              this.currentPriceInfo.increase = 0;
            }
            
            // 更新显示
            this.displayAccountInfo();
          }
          // 如果没有有效的价格数据，且上次价格数据已经超过1分钟，尝试使用API获取 (最低优先级)
          else if (!this.currentPriceInfo || !this.currentPriceInfo.updateTime || 
                    (Date.now() - this.currentPriceInfo.updateTime > 60000)) {
            log('WebSocket无有效价格数据，尝试通过API获取价格');
            // 触发priceMonitor中的API价格获取
            this.priceMonitor.fetchPriceFromApi(false);
          }
        } catch (error) {
          log(`价格轮询错误: ${error.message}`, true);
        }
      }, 5000);
      
      // 添加资源状态同步计划任务 - 每2分钟同步一次订单状态
      this.resourceSyncInterval = setInterval(async () => {
        try {
          // 只在应用运行时执行同步
          if (!this.running) return;
          
          log('执行订单状态同步...');
          
          // 注意：余额同步功能已禁用，以减少API请求频率
          
          // 同步订单状态
          await this.queryOrdersAndUpdateStats();
          
          log('订单状态同步完成');
        } catch (error) {
          log(`资源状态同步出错: ${error.message}`, true);
        }
      }, 120000); // 2分钟同步一次
      
      this.running = true;
      
      // 返回成功
      return true;
    } catch (error) {
      log(`启动应用程序失败: ${error.message}`, true);
      this.stop();
      return false;
    }
  }
  
  /**
   * 停止交易应用
   */
  async stop() {
    if (!this.running) return;
    
    log('正在停止应用程序...');
    
    try {
      // 先取消所有订单
      try {
        await this.cancelAllOrders();
        log('已取消所有未完成订单');
      } catch (cancelError) {
        log(`取消订单时出错: ${cancelError.message}`, true);
      }
      
      // 停止WebSocket相关资源 - 增强错误处理
      try {
        // 停止价格监控
        if (this.priceMonitor) {
          log('正在停止价格监控...');
          this.priceMonitor.stopMonitoring();
          log('已停止价格监控');
          
          // 关闭WebSocket连接
          if (this.priceMonitor.wsManager) {
            log('正在关闭WebSocket连接...');
            // 确保先关闭WebSocket连接
            this.priceMonitor.wsManager.closeWebSocket();
            // 清理所有连接状态并重置计数器，避免后续重新启动时出现问题
            this.priceMonitor.wsManager.resetConnectionState();
            this.priceMonitor.wsManager.closeAllConnections();
            log('已关闭所有WebSocket连接');
          }
        }
      } catch (wsError) {
        log(`关闭WebSocket连接时出错: ${wsError.message}`, true);
        // 尝试强制清理
        try {
          if (this.priceMonitor && this.priceMonitor.wsManager) {
            if (this.priceMonitor.wsManager.ws) {
              this.priceMonitor.wsManager.ws.terminate();
              this.priceMonitor.wsManager.ws = null;
            }
            // 确保连接计数为0，避免后续问题
            this.priceMonitor.wsManager.activeConnectionCount = 0;
            this.priceMonitor.wsManager.connectOperationInProgress = false;
            log('已强制终止WebSocket连接并清理状态');
          }
        } catch (forceCloseError) {
          log(`强制关闭WebSocket连接时出错: ${forceCloseError.message}`, true);
        }
      }
      
      // 清除所有定时器
      const timers = [
        this.monitoringInterval,
        this.priceCheckInterval,
        this.resourceSyncInterval, // 清除资源同步定时器
        this.priceMonitor?.checkInterval,
        this.priceMonitor?.wsManager?.heartbeatInterval,
        this.priceMonitor?.wsManager?.reconnectTimeout
      ];
      
      // 清除所有可能的定时器
      timers.forEach(timer => {
        if (timer) {
          try {
            clearInterval(timer);
            clearTimeout(timer);
          } catch (timerError) {
            log(`清除定时器时出错: ${timerError.message}`, true);
          }
        }
      });
      
      // 重置定时器引用
      this.monitoringInterval = null;
      this.priceCheckInterval = null;
      this.resourceSyncInterval = null; // 重置资源同步定时器引用
      if (this.priceMonitor) {
        this.priceMonitor.checkInterval = null;
        if (this.priceMonitor.wsManager) {
          this.priceMonitor.wsManager.heartbeatInterval = null;
          this.priceMonitor.wsManager.reconnectTimeout = null;
        }
      }
      
      log('已清除所有定时器');
      
      // 记录最终状态
      this.displayStats();
      
      // 标记为已停止
      this.running = false;
      log('应用程序已停止');
    } catch (error) {
      log(`停止应用程序时发生错误: ${error.message}`, true);
      this.running = false;
    }
  }
  
  /**
   * 撤销所有未成交订单
   */
  async cancelAllOrders() {
    if (!this.running) {
      log('应用程序未运行，无法撤销订单');
      return false;
    }
    
    try {
      log(`开始撤销 ${this.symbol} 交易对的所有未完成订单...`);
      const result = await this.backpackService.cancelAllOrders(this.symbol);
      log(`撤销订单结果: ${JSON.stringify(result)}`);
      return true;
    } catch (error) {
      log(`撤销订单失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 执行交易操作
   */
  async executeTrade() {
    try {
      log('开始执行交易策略...');
      
      // 检查当前价格
      if (!this.currentPrice || this.currentPrice <= 0) {
        log('警告: 当前价格无效，无法执行交易');
        return false;
      }
      
      log(`当前价格: ${this.currentPrice} USDC`);
      
      // 取消所有现有订单
      try {
        await this.backpackService.cancelAllOrders(this.apiSymbol);
        log('已取消所有现有订单');
      } catch (error) {
        log(`取消所有订单失败: ${error.message}`);
      }
      
      // 从配置中获取交易参数
      const maxDropPercentage = this.config.trading.maxDropPercentage;
      const totalAmount = this.config.trading.totalAmount;
      const orderCount = this.config.trading.orderCount;
      const incrementPercentage = this.config.trading.incrementPercentage;
      const minOrderAmount = this.config.advanced?.minOrderAmount || 10;
      
      // 确保所有交易参数都有效
      if (!maxDropPercentage || !totalAmount || !orderCount || !incrementPercentage) {
        log('警告: 交易参数无效，请检查配置文件', true);
        return false;
      }
      
      // 计算阶梯订单
      const orders = this.tradingStrategy.calculateIncrementalOrders(
        this.currentPrice,
        maxDropPercentage,
        totalAmount,
        orderCount,
        incrementPercentage,
        minOrderAmount,
        this.tradingCoin,
        this.apiSymbol
      );
      
      if (!orders || orders.length === 0) {
        log('警告: 没有生成有效的订单');
        return false;
      }
      
      log(`已生成 ${orders.length} 个阶梯买单`);
      
      // 创建订单
      let successCount = 0;
      for (const order of orders) {
        try {
          // 检查是否已存在相同的订单
          const orderSignature = `${order.symbol}_${order.price}_${order.quantity}`;
          if (this.orderManager.hasOrderSignature(orderSignature)) {
            log(`跳过重复订单: ${orderSignature}`);
            continue;
          }
          
          // 创建订单
          const result = await this.backpackService.createOrder({
            symbol: this.apiSymbol,
            side: 'Bid',
            orderType: 'Limit',
            price: order.price.toFixed(2),
            quantity: order.quantity.toFixed(6)
          });
          
          if (result && result.id) {
            // 添加到订单管理器
            const newOrder = new Order({
              id: result.id,
              symbol: order.symbol,
              side: 'Bid',
              price: order.price,
              quantity: order.quantity,
              status: result.status || 'New'
            });
            
            // 添加订单到管理器，并记录这个签名
            this.orderManager.addOrder(newOrder);
            this.orderManager.createdOrderSignatures.add(orderSignature);
            
            // 增加总订单计数
            this.tradeStats.totalOrders++;
            
            // 在终端显示订单创建信息（确保显示）
            log(`订单已创建: ${result.id} - ${order.quantity} ${this.tradingCoin} @ ${order.price} USDC`);
            successCount++;
          } else {
            log(`订单创建失败: ${JSON.stringify(order)}`);
          }
        } catch (error) {
          log(`创建订单失败: ${error.message}, 订单: ${JSON.stringify(order)}`);
        }
      }
      
      log(`成功创建 ${successCount}/${orders.length} 个订单`);
      
      // 更新最后交易时间
      this.lastTradeTime = new Date();
      
      // 启动止盈监控
      this.startTakeProfitMonitoring();
      
      return successCount > 0;
    } catch (error) {
      log(`执行交易操作失败: ${error.message}`);
      if (error.stack) {
        log(`错误堆栈: ${error.stack}`);
      }
      return false;
    }
  }
  
  /**
   * 查询订单并更新统计
   */
  async queryOrdersAndUpdateStats() {
    try {
      log('查询当前交易周期新成交的订单...');
      
      // 获取当前未成交订单
      const openOrders = await this.backpackService.getOpenOrders(this.symbol);
      const currentOpenOrderIds = new Set(openOrders.map(order => order.id));
      
      // 获取所有历史订单（包括已成交和已取消的）
      try {
        const allOrders = await this.backpackService.getOrderHistory(this.symbol);
        
        // 更新所有历史订单的状态
        if (allOrders && allOrders.length > 0) {
          log(`获取到 ${allOrders.length} 个历史订单记录`);
          
          // 处理历史订单
          for (const historyOrder of allOrders) {
            if (historyOrder.id && historyOrder.status === 'Filled') {
              // 查找本地订单记录
              const localOrder = this.orderManager.getOrder(historyOrder.id);
              
              // 如果本地有此订单且未处理，更新其状态
              if (localOrder && !this.tradeStats.isOrderProcessed(historyOrder.id)) {
                // 使用API返回的实际成交数据
                localOrder.status = 'Filled';
                localOrder.filledQuantity = parseFloat(historyOrder.filledQuantity || historyOrder.quantity);
                localOrder.filledAmount = parseFloat(historyOrder.filledAmount || (historyOrder.price * historyOrder.quantity));
                
                log(`从API确认订单已成交: ${historyOrder.id} - ${localOrder.quantity} ${this.tradingCoin} @ ${localOrder.price} USDC`);
              }
            }
          }
        }
      } catch (historyError) {
        log(`获取订单历史出错: ${historyError.message}`, true);
        // 继续处理，使用备用方法
      }
      
      // 备用方法：遍历所有创建的订单，检查哪些已经不在未成交列表中
      const filledOrders = [];
      for (const orderId of this.orderManager.getAllCreatedOrderIds()) {
        if (!currentOpenOrderIds.has(orderId)) {
          const order = this.orderManager.getOrder(orderId);
          
          // 如果订单存在且未处理，则视为已成交
          if (order && !this.tradeStats.isOrderProcessed(orderId)) {
            // 将订单标记为已成交
            order.status = 'Filled';
            
            // 确保设置正确的成交数量和金额
            // 如果订单已成交，应该将全部数量和金额标记为已成交
            if (order.filledQuantity <= 0) {
              order.filledQuantity = order.quantity;
            }
            
            if (order.filledAmount <= 0) {
              order.filledAmount = order.price * order.quantity;
            }
            
            // 添加到已成交订单列表
            filledOrders.push(order);
            
            // 记录订单成交信息
            log(`推断订单已成交: ${orderId} - ${order.quantity} ${this.tradingCoin} @ ${order.price} USDC`);
          }
        }
      }
      
      // 更新统计信息
      let updatedCount = 0;
      for (const order of filledOrders) {
        const result = this.tradeStats.updateStats(order);
        if (result) {
          updatedCount++;
          // 如果统计更新成功，记录成交信息
          log(`更新交易统计: 成交订单数=${this.tradeStats.filledOrders}, 均价=${this.tradeStats.averagePrice.toFixed(2)} USDC`);
        }
      }
      
      // 如果有订单更新，记录详细统计
      if (updatedCount > 0) {
        this.logger.logToFile(`===订单统计更新===`);
        this.logger.logToFile(`总订单数: ${this.tradeStats.totalOrders}`);
        this.logger.logToFile(`成交订单数: ${this.tradeStats.filledOrders}`);
        this.logger.logToFile(`总成交数量: ${this.tradeStats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
        this.logger.logToFile(`总成交金额: ${this.tradeStats.totalFilledAmount.toFixed(2)} USDC`);
        this.logger.logToFile(`平均成交价: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
      }
      
      // 更新订单管理器中的待处理订单ID列表
      this.orderManager.updatePendingOrderIds(Array.from(currentOpenOrderIds));
      
      return filledOrders.length > 0;
    } catch (error) {
      log(`查询订单历史并更新统计失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 开始监控止盈条件
   */
  async startTakeProfitMonitoring() {
    if (!this.running) {
      log('应用程序未运行，无法开始监控止盈条件');
      return false;
    }
    
    // 获取止盈百分比
    const takeProfitPercentage = this.config.trading.takeProfitPercentage;
    log(`\n开始监控止盈条件 (${takeProfitPercentage}%)...`);
    
    // 首次显示账户信息
    this.displayAccountInfo();
    
    // 启动监控间隔
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    // 监控变量
    let monitoringAttempts = 0;
    this.takeProfitTriggered = false;
    let lastOrderCheckTime = Date.now();
    
    // 无订单成交自动重启相关变量
    const autoRestartNoFill = this.config.actions.autoRestartNoFill === true;
    const noFillRestartMinutes = this.config.advanced.noFillRestartMinutes || 60;
    const noFillRestartMs = noFillRestartMinutes * 60 * 1000;
    const initialStartTime = Date.now();
    let hadFilledOrders = this.tradeStats.filledOrders > 0;
    
    if (autoRestartNoFill) {
      log(`启用无订单成交自动重置: 如果 ${noFillRestartMinutes} 分钟内没有订单成交，将自动重置应用状态`);
    }
    
    // 添加心跳计时器
    const heartbeatInterval = setInterval(() => {
      const timeNow = new Date().toLocaleString();
      this.logger.logToFile(`心跳检查: 脚本正在运行 ${timeNow}`);
    }, 60000);
    
    this.monitoringInterval = setInterval(async () => {
      try {
        monitoringAttempts++;
        
        // 记录每一轮监控的开始
        const cycleStartTime = Date.now();
        this.logger.logToFile(`开始第 ${monitoringAttempts} 轮订单监控检查`);
        
        // 更新显示
        this.displayAccountInfo();
        
        // 每次检查前都更新统计数据，确保使用最新的订单状态
        let hasFilledOrders = false;
        try {
          hasFilledOrders = await this.queryOrdersAndUpdateStats();
        } catch (statsError) {
          this.logger.logToFile(`更新订单统计时出错: ${statsError.message}`, true);
        }
        
        // 如果之前没有成交订单，但现在有了，则记录这一状态变化
        if (!hadFilledOrders && hasFilledOrders) {
          this.logger.logToFile(`检测到首次订单成交，自动重置计时器已取消`);
          hadFilledOrders = true;
        }
        
        // 检查是否需要因无订单成交而重置
        if (autoRestartNoFill && !hadFilledOrders && this.tradeStats.filledOrders === 0) {
          const runningTimeMs = Date.now() - initialStartTime;
          
          if (runningTimeMs >= noFillRestartMs) {
            log(`\n===== 无订单成交自动重置触发 =====`);
            log(`已运行 ${Math.floor(runningTimeMs / 60000)} 分钟无任何订单成交`);
            log(`根据配置，系统将重置应用状态并重新开始交易...`);
            
            // 先取消所有未成交订单
            await this.cancelAllOrders();
            
            // 添加卖出余额操作，与止盈流程保持一致
            try {
              log('执行卖出持仓操作...');
              // 卖出所有持仓
              await this.sellAllPosition();
            } catch (sellError) {
              log(`卖出操作失败: ${sellError.message}`, true);
              // 即使卖出失败也继续重置流程
            }
            
            clearInterval(heartbeatInterval);
            clearInterval(this.monitoringInterval);
            
            // 显式停止价格监控，确保WebSocket连接正确关闭
            log('停止价格监控和WebSocket连接...');
            this.priceMonitor.stopMonitoring();
            
            // 确保WebSocket连接被显式关闭
            if (this.priceMonitor.wsManager) {
              this.priceMonitor.wsManager.closeAllConnections();
              log('已关闭所有WebSocket连接');
            }
            
            // 重置应用状态
            this.resetAppState();
            
            // 重新初始化应用
            log('正在重新初始化交易环境...');
            await this.initialize();
            
            // 重新启动应用
            await this.start();
            
            // 重新执行交易策略
            await this.executeTrade();
            
            return true;
          }
        }
        
        // 定期检查未成交的订单状态
        const orderCheckIntervalMs = Math.max(1, this.config.advanced.checkOrdersIntervalMinutes || 10) * 60 * 1000;
        const checkTimeNow = Date.now();
        
        if (checkTimeNow - lastOrderCheckTime > orderCheckIntervalMs) {
          await this.queryOrdersAndUpdateStats();
          lastOrderCheckTime = checkTimeNow;
        }
        
        // 注：价格和止盈检查已经在handlePriceUpdate方法中处理
        
      } catch (error) {
        log(`监控过程中发生错误: ${error.message}`, true);
        // 出错后等待短一点的时间再继续，避免长时间卡住
      }
    }, this.config.advanced.monitorIntervalSeconds * 1000);
  }
  
  /**
   * 卖出所有持仓
   */
  async sellAllPosition() {
    try {
      // 获取当前持仓情况 - 修正：使用tradingCoin而非symbol获取持仓
      const position = await this.backpackService.getPosition(this.tradingCoin);
      if (!position) {
        log('无法获取持仓信息');
        return null;
      }
      
      log(`获取到${this.tradingCoin}持仓信息: ${JSON.stringify(position)}`);
      
      // 确保quantity是有效的数字，使用available属性作为可用数量
      const rawQuantity = parseFloat(position.available || position.total || "0");
      if (isNaN(rawQuantity) || rawQuantity <= 0) {
        log(`持仓数量无效: ${position.available}, 总量: ${position.total}`);
        return null;
      }
      
      // 获取当前市场价格
      const ticker = await this.backpackService.getTicker(this.symbol);
      if (!ticker || !ticker.lastPrice) {
        log('无法获取当前市场价格');
        return null;
      }
      
      const currentPrice = parseFloat(ticker.lastPrice);
      if (isNaN(currentPrice) || currentPrice <= 0) {
        log(`获取的价格无效: ${ticker.lastPrice}`);
        return null;
      }
      
      // 设置卖出价格
      const sellPrice = this.tradingStrategy.calculateOptimalSellPrice(currentPrice, this.tradingCoin);
      if (isNaN(sellPrice) || sellPrice <= 0) {
        log(`计算的卖出价格无效: ${sellPrice}`);
        return null;
      }
      
      // 调整数量精度
      const quantity = Formatter.adjustQuantityToStepSize(rawQuantity, this.tradingCoin, this.config);
      if (isNaN(quantity) || quantity <= 0) {
        log(`调整后的数量无效: ${quantity}`);
        return null;
      }
      
      log(`准备卖出: ${quantity} ${this.tradingCoin}, 当前市场价=${currentPrice}, 卖出价=${sellPrice}`);
      
      // 创建卖出订单 - 修正参数顺序
      const response = await this.backpackService.createSellOrder(
        sellPrice,
        quantity,
        this.symbol
      );
      
      if (response && response.id) {
        log(`卖出订单创建成功: 订单ID=${response.id}, 状态=${response.status}`);
        
        // 检查订单是否完全成交
        let fullyFilled = response.status === 'Filled';
        
        // 如果订单未完全成交，尝试再次以更低价格卖出剩余部分
        if (!fullyFilled) {
          log('订单未完全成交，检查剩余数量并尝试以更低价格卖出');
          
          // 等待一小段时间，让订单有时间处理
          await TimeUtils.delay(2000);
          
          // 获取更新后的持仓
          const updatedPosition = await this.backpackService.getPosition(this.symbol);
          if (updatedPosition && parseFloat(updatedPosition.quantity) > 0) {
            const updatedRawQuantity = parseFloat(updatedPosition.quantity);
            if (isNaN(updatedRawQuantity) || updatedRawQuantity <= 0) {
              log(`更新后的持仓数量无效: ${updatedPosition.quantity}`);
              return response;
            }
            
            const remainingQuantity = Formatter.adjustQuantityToStepSize(updatedRawQuantity, this.tradingCoin, this.config);
            if (isNaN(remainingQuantity) || remainingQuantity <= 0) {
              log(`调整后的剩余数量无效: ${remainingQuantity}`);
              return response;
            }
            
            log(`仍有 ${remainingQuantity} ${this.tradingCoin} 未售出，尝试以更低价格卖出`);
            
            // 计算更低的卖出价格
            const lowerSellPrice = this.tradingStrategy.calculateSecondSellPrice(currentPrice, this.tradingCoin);
            if (isNaN(lowerSellPrice) || lowerSellPrice <= 0) {
              log(`计算的第二次卖出价格无效: ${lowerSellPrice}`);
              return response;
            }
            
            // 创建第二次卖出订单 - 修正参数顺序
            const secondResponse = await this.backpackService.createSellOrder(
              lowerSellPrice,
              remainingQuantity,
              this.symbol
            );
            
            if (secondResponse && secondResponse.id) {
              log(`第二次卖出订单创建成功: 订单ID=${secondResponse.id}, 状态=${secondResponse.status}`);
            }
          } else {
            log(`所有 ${this.tradingCoin} 已售出`);
          }
        }
        
        return response;
      } else {
        throw new Error('卖出订单创建失败：响应中没有订单ID');
      }
    } catch (error) {
      log(`卖出失败: ${error.message}`, true);
      return null;
    }
  }
  
  /**
   * 显示账户信息
   */
  displayAccountInfo() {
    try {
      // 准备数据
      const timeNow = new Date().toLocaleString();
      const takeProfitPercentage = this.config.trading.takeProfitPercentage;
      const elapsedTime = TimeUtils.getElapsedTime(this.scriptStartTime);
      
      // 价格信息
      let priceInfo = "等待WebSocket数据...";
      let priceChangeSymbol = "";
      let percentProgress = "0";
      
      // 获取当前的WebSocket连接状态
      let wsConnected = this.priceMonitor.isMonitoring();
      
      // 显示WebSocket连接状态及上次更新时间
      let wsStatusInfo = wsConnected ? "已连接" : "连接中...";
      
      // 如果有价格监控的上次更新时间，显示距离上次更新的时间
      if (this.priceMonitor.lastUpdateTime) {
        const lastUpdateTimeString = new Date(this.priceMonitor.lastUpdateTime).toLocaleTimeString();
        const dataAge = Math.floor((Date.now() - this.priceMonitor.lastUpdateTime) / 1000);
        wsStatusInfo += ` (${lastUpdateTimeString}, ${dataAge}秒前)`;
      }
      
      // 尝试所有可能的来源获取价格数据
      let priceFound = false;
      
      // 1. 首先尝试使用已有的价格信息
      if (this.currentPriceInfo && this.currentPriceInfo.price) {
        const currentPrice = this.currentPriceInfo.price;
        priceInfo = `${currentPrice.toFixed(1)} USDC`;
        
        // 如果有价格数据来源，显示来源
        if (this.currentPriceInfo.source) {
          priceInfo += ` (来源: ${this.currentPriceInfo.source})`;
        }
        
        priceFound = true;
      } 
      // 2. 如果没有价格信息，尝试从PriceMonitor获取
      else if (this.priceMonitor && this.priceMonitor.currentPrice > 0) {
        const currentPrice = this.priceMonitor.currentPrice;
        priceInfo = `${currentPrice.toFixed(1)} USDC (来源: 监控模块)`;
        
        // 更新到应用状态
        this.currentPriceInfo = {
          price: currentPrice,
          source: '监控模块',
          updateTime: this.priceMonitor.lastUpdateTime || Date.now()
        };
        
        priceFound = true;
      } 
      // 3. 如果仍然没有价格，尝试从WebSocketManager直接获取
      else if (this.priceMonitor && this.priceMonitor.wsManager && 
              this.priceMonitor.wsManager.lastPriceData && 
              this.priceMonitor.wsManager.lastPriceData.price > 0) {
        
        const wsPrice = this.priceMonitor.wsManager.lastPriceData;
        const currentPrice = wsPrice.price;
        priceInfo = `${currentPrice.toFixed(1)} USDC (来源: WebSocket直接获取)`;
        
        // 更新到应用状态
        this.currentPriceInfo = {
          price: currentPrice,
          source: 'WebSocket直接获取',
          updateTime: wsPrice.time || Date.now()
        };
        
        priceFound = true;
      }
      // 4. 尝试从API获取最新价格
      else if (!priceFound) {
        try {
          this.backpackService.getTicker(this.symbol)
            .then(ticker => {
              if (ticker && ticker.lastPrice) {
                const apiPrice = parseFloat(ticker.lastPrice);
                // 只更新状态，不直接影响当前显示
                this.currentPriceInfo = {
                  price: apiPrice,
                  source: 'API请求',
                  updateTime: Date.now()
                };
                
                // 在下一次调用displayAccountInfo时会使用这个价格
                log(`从API获取到价格: ${apiPrice} USDC`);
              }
            })
            .catch(error => {
              log(`API获取价格失败: ${error.message}`);
            });
        } catch (apiError) {
          // 如果API请求失败，静默处理
        }
      }
      
      // 如果找到了价格数据并且有成交均价，计算涨跌幅和进度
      if (priceFound && this.tradeStats.filledOrders > 0 && this.tradeStats.averagePrice > 0) {
        const currentPrice = this.currentPriceInfo.price;
        // 计算涨跌幅
        const priceChange = ((currentPrice - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
        this.currentPriceInfo.increase = priceChange;
        
        const absChange = Math.abs(priceChange).toFixed(2);
        priceChangeSymbol = priceChange >= 0 ? "↑" : "↓";
        
        // 计算离止盈目标的进度百分比
        if (priceChange > 0 && takeProfitPercentage > 0) {
          percentProgress = this.tradingStrategy.calculateProgressPercentage(
            currentPrice, 
            this.tradeStats.averagePrice, 
            takeProfitPercentage
          ).toFixed(0);
        }
      } else {
        // 没有成交订单时重置涨跌幅显示
        priceChangeSymbol = "";
        percentProgress = "0";
        if (this.currentPriceInfo) {
          this.currentPriceInfo.increase = 0;
        }
      }
      
      // 计算盈亏情况
      let currentValue = 0;
      let profit = 0;
      let profitPercent = 0;
      
      if (this.tradeStats.filledOrders > 0 && this.currentPriceInfo && this.currentPriceInfo.price && this.tradeStats.totalFilledQuantity > 0) {
        currentValue = this.currentPriceInfo.price * this.tradeStats.totalFilledQuantity;
        profit = currentValue - this.tradeStats.totalFilledAmount;
        profitPercent = profit / this.tradeStats.totalFilledAmount * 100;
      }
      
      // 格式化并显示
      const data = {
        timeNow,
        symbol: this.symbol,
        scriptStartTime: this.scriptStartTime.toLocaleString(),
        elapsedTime,
        wsStatusInfo,
        priceInfo,
        priceChangeSymbol,
        increase: this.currentPriceInfo?.increase || 0,
        takeProfitPercentage,
        percentProgress,
        stats: this.tradeStats,
        tradingCoin: this.tradingCoin,
        currentValue,
        profit,
        profitPercent,
        priceSource: this.currentPriceInfo?.source
      };
      
      // 格式化并显示
      const display = Formatter.formatAccountInfo(data);
      console.clear();
      console.log(display);
      
      this.displayInitialized = true;
    } catch (error) {
      // 如果显示过程出错，回退到简单显示
      log(`显示信息时发生错误: ${error.message}`);
      // 简单显示函数
      console.log(`\n价格: ${this.currentPriceInfo?.price || '未知'} USDC`);
      console.log(`订单: ${this.tradeStats.filledOrders}/${this.tradeStats.totalOrders}`);
      console.log(`错误: ${error.message}`);
    }
  }
  
  /**
   * 显示统计信息
   */
  displayStats() {
    const stats = this.tradeStats;
    
    log('\n=== 订单统计信息 ===');
    log(`总挂单次数: ${stats.totalOrders}`);
    log(`已成交订单: ${stats.filledOrders}`);
    log(`总成交金额: ${stats.totalFilledAmount.toFixed(2)} USDC`);
    log(`总成交数量: ${stats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
    log(`平均成交价格: ${stats.averagePrice.toFixed(2)} USDC`);
    
    // 计算并显示盈亏情况
    if (stats.filledOrders > 0 && this.currentPriceInfo && this.currentPriceInfo.price && stats.totalFilledQuantity > 0) {
      const currentPrice = this.currentPriceInfo.price;
      const currentValue = currentPrice * stats.totalFilledQuantity;
      const cost = stats.totalFilledAmount;
      const profit = currentValue - cost;
      const profitPercent = (profit / cost * 100);
      
      // 获取当前价格相对于平均价格的涨跌幅
      const priceChange = ((currentPrice - stats.averagePrice) / stats.averagePrice) * 100;
      
      // 计算达到止盈目标的进度
      const takeProfitPercentage = this.config.trading.takeProfitPercentage;
      let takeProfitProgress = '0%';
      
      if (priceChange > 0 && takeProfitPercentage > 0) {
        takeProfitProgress = `${Math.min(100, (priceChange / takeProfitPercentage * 100)).toFixed(0)}%`;
      }
      
      // 添加颜色指示和箭头符号
      const priceChangeSymbol = priceChange >= 0 ? '↑' : '↓';
      const profitSymbol = profit >= 0 ? '↑' : '↓';
      
      log(`当前市场价格: ${currentPrice.toFixed(2)} USDC`);
      log(`价格涨跌幅: ${priceChangeSymbol} ${Math.abs(priceChange).toFixed(2)}%`);
      log(`距离止盈目标: ${takeProfitPercentage}% (已完成: ${takeProfitProgress})`);
      log(`当前持仓价值: ${currentValue.toFixed(2)} USDC`);
      log(`盈亏金额: ${profitSymbol} ${Math.abs(profit).toFixed(2)} USDC`);
      log(`盈亏百分比: ${profitSymbol} ${Math.abs(profitPercent).toFixed(2)}%`);
      
      // 添加数据来源信息
      if (this.currentPriceInfo.source) {
        log(`价格数据来源: ${this.currentPriceInfo.source}`);
      }
      
      // 显示数据更新时间
      if (this.currentPriceInfo.updateTime) {
        const updateTime = new Date(this.currentPriceInfo.updateTime);
        const dataAge = Math.floor((Date.now() - updateTime) / 1000);
        log(`价格更新时间: ${updateTime.toLocaleTimeString()} (${dataAge}秒前)`);
      }
    } else if (stats.filledOrders === 0) {
      log(`尚无成交订单，无法计算盈亏情况`);
    } else if (!this.currentPriceInfo || !this.currentPriceInfo.price) {
      log(`无法获取当前价格，无法计算盈亏情况`);
    }
    
    log(`统计数据最后更新: ${stats.lastUpdateTime ? stats.lastUpdateTime.toLocaleString() : '无'}`);
    log(`已处理订单数量: ${stats.processedOrderIds ? stats.processedOrderIds.size : 0}`);
    log('==================\n');
  }
  
  /**
   * 重置应用状态
   */
  resetAppState() {
    log('\n===== 重置应用状态 =====');
    log('开始进行完整系统重置，确保所有资源被正确清理...');
    
    // 停止所有计时器和监控任务
    log('1. 清理所有计时器和监控任务...');
    if (this.priceCheckInterval) {
      clearInterval(this.priceCheckInterval);
      this.priceCheckInterval = null;
      log('- 价格检查定时器已清理');
    }
    
    if (this.resourceSyncInterval) {
      clearInterval(this.resourceSyncInterval);
      this.resourceSyncInterval = null;
      log('- 资源同步定时器已清理');
    }
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      log('- 监控定时器已清理');
    }
    
    // 重置全局配置的一些状态
    log('2. 重置应用核心状态...');
    this.scriptStartTime = new Date();
    log(`- 程序启动时间已重置: ${this.scriptStartTime.toLocaleString()}`);
    
    // 完全重置交易统计和订单管理器
    log('3. 重置交易统计和订单数据...');
    this.tradeStats.reset();
    this.orderManager.reset();
    log('- 交易统计和订单管理器已重置');
    
    // 关闭和清理网络相关资源
    log('4. 清理WebSocket和网络资源...');
    if (this.priceMonitor) {
      // 详细记录PriceMonitor状态
      log(`- PriceMonitor状态: ${this.priceMonitor.monitoring ? '监控中' : '未监控'}`);
      
      try {
        // 检查是否需要先停止监控
        if (this.priceMonitor.monitoring) {
          this.priceMonitor.stopMonitoring();
          log('- 价格监控已停止');
        }
        
        // 额外确保WebSocket连接关闭
        if (this.priceMonitor.wsManager) {
          log(`- WebSocketManager状态: 连接数=${this.priceMonitor.wsManager.activeConnectionCount}`);
          this.priceMonitor.wsManager.closeAllConnections();
          log('- 所有WebSocket连接已关闭');
          
          // 清理WebSocketManager中缓存的价格数据
          this.priceMonitor.wsManager.lastPriceData = null;
          log('- WebSocketManager缓存的价格数据已清除');
        }
        
        // 使用专门的方法清理价格数据
        this.priceMonitor.clearPriceData();
        log('- PriceMonitor价格数据已清理');
      } catch (error) {
        log(`清理WebSocket资源时出错: ${error.message}`, true);
      }
    }
    
    // 重置API服务状态
    log('5. 重置API服务状态...');
    if (this.backpackService) {
      // 重置API请求计数和缓存
      this.backpackService.resetRequestState();
      log('- API服务状态已重置');
    }
    
    // 重置监控和价格状态变量
    log('6. 重置监控和价格状态变量...');
    this.takeProfitTriggered = false;
    this.currentPriceInfo = null;  // 清空价格信息
    this.currentPrice = 0;  // 清理可能保存的当前价格
    this.displayInitialized = false;
    log('- 监控和价格状态变量已重置');
    
    // 创建新的日志周期
    this.cycleLogFile = this.logger.createCycleLogFile();
    log(`- 新的日志周期已创建: ${this.cycleLogFile}`);
    
    // 重置交易相关数据
    log('7. 重置交易和余额数据...');
    this.usdcBalance = 0;
    this.usdcTotal = 0;
    this.coinBalance = 0;
    this.coinTotal = 0;
    log('- 余额数据已重置');
    
    // 清空价格变化相关的数据，避免显示旧的涨跌幅
    this.lastDisplayTime = 0;
    this.lastPriceLogTime = null;
    this.lastLoggedPrice = null;
    this.lastRelativePriceLogTime = null; // 重置相对均价日志时间
    log('- 价格变化数据已重置');
    
    // 重置交易状态标志
    this.running = false; // 确保运行状态被重置
    log('- 应用运行状态已重置为未运行');
    
    // 重置其他可能的状态变量
    this.lastTradeTime = new Date(); // 重置最后交易时间
    this.lastStatusLogTime = new Date(); // 重置最后状态日志时间
    log('- 其他状态变量已重置');
    
    // 额外验证：确保成交订单数和均价已重置
    if (this.tradeStats.filledOrders > 0 || this.tradeStats.averagePrice > 0) {
      log('警告: 重置后交易统计数据未完全清零，强制清零...', true);
      // 强制清零关键统计数据
      this.tradeStats.filledOrders = 0;
      this.tradeStats.totalFilledAmount = 0;
      this.tradeStats.totalFilledQuantity = 0;
      this.tradeStats.averagePrice = 0;
      this.tradeStats.processedOrderIds.clear();
      log('- 交易统计数据已强制清零');
    }
    
    log('✓ 应用状态已完全重置，系统现在处于新启动状态');
    log('===== 应用状态重置完成 =====\n');
  }
  
  /**
   * 是否达到止盈条件
   */
  isTakeProfitTriggered() {
    return this.takeProfitTriggered;
  }
  
  /**
   * 检查应用是否正在运行
   */
  isRunning() {
    return this.running;
  }
  
  /**
   * 检查是否需要重启 (此方法已不再使用，保留为了向后兼容)
   * @deprecated 已弃用，现在使用内部状态重置代替重启
   * @returns {boolean} 永远返回false
   */
  isRestartNeeded() {
    return false; // 永远返回false，因为我们不再使用重启机制
  }
  
  /**
   * 获取实时余额（交易前同步调用）
   * 在每次关键交易操作前同步账户余额
   * 注意：此功能已禁用，以减少API请求频率
   */
  async syncBalances() {
    // 此功能已禁用，以减少API请求负担
    log('余额同步功能已禁用，以减少API请求频率');
    
    // 返回成功状态，避免影响依赖此方法的其他功能
    return true;
  }
  
  /**
   * 执行交易前的状态验证
   * @returns {boolean} 状态是否有效
   */
  async validateTradeState() {
    // 同步最新余额
    const balanceSynced = await this.syncBalances();
    if (!balanceSynced) {
      log('无法获取最新余额，交易将基于可能过时的数据', true);
    }
    
    // 验证价格数据是否有效
    if (!this.currentPriceInfo || !this.currentPriceInfo.price) {
      log('缺少有效价格数据，无法进行交易', true);
      return false;
    }
    
    // 验证价格数据是否过时
    const now = Date.now();
    const priceAge = now - (this.currentPriceInfo.updateTime || 0);
    if (priceAge > 60000) { // 价格数据超过1分钟
      log(`价格数据可能已过时 (${Math.floor(priceAge/1000)}秒前)，尝试获取最新价格`, true);
      
      // 尝试从API获取最新价格
      try {
        const ticker = await this.backpackService.getTicker(this.symbol);
        if (ticker && ticker.lastPrice) {
          const price = parseFloat(ticker.lastPrice);
          this.currentPriceInfo = {
            price,
            symbol: this.symbol,
            source: 'API临时请求',
            updateTime: now
          };
          log(`已获取最新价格: ${price} USDC`);
        }
      } catch (error) {
        log(`获取最新价格失败: ${error.message}`, true);
        // 继续使用旧价格，但记录警告
        log('将使用可能过时的价格数据进行交易，请谨慎', true);
      }
    }
    
    return true;
  }
}

module.exports = TradingApp; 