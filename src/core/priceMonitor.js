const WebSocketManager = require('../network/webSocketManager');
const { log } = require('../utils/logger');
const TimeUtils = require('../utils/timeUtils');
const axios = require('axios');

/**
 * 价格监控类 - 负责监控价格变化和触发事件
 */
class PriceMonitor {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {Object} options.config - 全局配置
   * @param {Function} options.onPriceUpdate - 价格更新回调
   * @param {Function} options.onPriceData - 价格数据收到回调
   * @param {Object} options.logger - 日志记录器
   */
  constructor(options = {}) {
    this.config = options.config;
    this.logger = options.logger;
    this.onPriceUpdate = options.onPriceUpdate || (() => {});
    this.onPriceData = options.onPriceData || (() => {});
    
    // 初始化价格数据
    this.currentPrice = 0;
    this.lastPrice = 0;
    this.lastUpdateTime = null;
    this.priceSource = null;
    
    // 添加重启检测变量
    this.restartTime = null;
    
    // 添加消息去重机制
    this.processedPriceEvents = new Map(); // 存储已处理的价格事件
    this.maxProcessedEvents = 1000;        // 最多存储1000条记录
    this.cleanupInterval = null;           // 清理定时器
    
    // 初始化WebSocket管理器
    this.wsManager = options.wsManager || new WebSocketManager({
      config: this.config,
      logger: this.logger,
      onMessage: (data) => this.handleMessage(data),
      onPriceUpdate: (priceInfo, time) => this.handleWebSocketPriceUpdate(priceInfo, time)
    });
    
    // 初始化监控状态
    this.symbol = null;
    this.monitoring = false;
    this.reconnectAttempts = 0;
    this.checkInterval = null;
    this.usingFallbackApi = false;
    
    // 添加重试计数
    this.maxReconnectAttempts = 10;
    
    // 添加REST API相关设置
    this.restApiBaseUrl = 'https://api.backpack.exchange';
    this.binanceApiBaseUrl = 'https://api.binance.com';
    this.restApiEnabled = true;
    this.lastRestApiCheck = 0;
    this.restApiInterval = 60000; // 从20秒改为60秒
    this.restApiRetryInterval = 30000; // 新增API请求失败后的重试间隔（30秒）
    this.restApiConsecutiveFailures = 0; // 跟踪连续失败次数
    this.maxConsecutiveFailures = 5; // 最大连续失败次数，超过后会进一步延长间隔
    
    // 新增日志控制变量
    this.lastApiLogTime = 0; // 上次API价格日志记录时间
    
    // 超时设置
    this.wsConnectTimeout = null;
    this.initialDataTimeout = null;
    
    // 启动事件清理定时器
    this.setupEventCleanup();
  }
  
  /**
   * 设置事件清理定时器
   */
  setupEventCleanup() {
    // 清理可能存在的旧定时器
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // 每10分钟清理一次过期事件记录
    this.cleanupInterval = setInterval(() => {
      if (this.processedPriceEvents.size > 0) {
        const now = Date.now();
        const expireTime = 15 * 60 * 1000; // 15分钟过期
        
        // 删除15分钟前的事件记录
        for (const [key, timestamp] of this.processedPriceEvents.entries()) {
          if (now - timestamp > expireTime) {
            this.processedPriceEvents.delete(key);
          }
        }
        
        // 如果map变得太大，移除最早的记录
        if (this.processedPriceEvents.size > this.maxProcessedEvents) {
          const entriesToRemove = this.processedPriceEvents.size - this.maxProcessedEvents;
          const entries = Array.from(this.processedPriceEvents.entries())
            .sort((a, b) => a[1] - b[1])
            .slice(0, entriesToRemove);
          
          for (const [key] of entries) {
            this.processedPriceEvents.delete(key);
          }
        }
      }
    }, 10 * 60 * 1000); // 10分钟
  }
  
  /**
   * 启动价格监控
   * @param {string} symbol - 交易对符号
   * @returns {boolean} 是否成功启动
   */
  startMonitoring(symbol) {
    if (this.monitoring) {
      log(`已经在监控 ${this.symbol} 的价格`);
      // 检查WebSocket是否仍然可用
      if (this.wsManager) {
        const isConnected = this.wsManager.isConnected();
        const isInProgress = this.wsManager.connectOperationInProgress;
        const isSubscribed = this.wsManager.subscriptionState?.isSubscribed;
        
        log(`WebSocket连接状态: ${isConnected ? '已连接' : '未连接'}, 连接操作: ${isInProgress ? '进行中' : '无'}, 订阅状态: ${isSubscribed ? '已订阅' : '未订阅'}`);
        
        // 仅在WebSocket未连接且没有连接操作进行中时才尝试重新连接
        if (!isConnected && !isInProgress) {
          log(`检测到WebSocket未连接且无操作进行中，正在重新建立连接...`);
          this.wsManager.setupPriceWebSocket(symbol);
        }
      }
      return true;
    }
    
    this.symbol = symbol;
    this.monitoring = true;
    this.startMonitoringTime = Date.now();  // 添加监控开始时间
    this.reconnectAttempts = 0;  // 重置重连计数
    this.usingFallbackApi = false;
    
    // 清理旧的价格数据
    this.clearPriceData();
    
    // 关闭并重置现有的WebSocket连接
    if (this.wsManager) {
      // 只有在WebSocket连接活跃或存在连接操作时才需要关闭
      if (this.wsManager.isConnected() || this.wsManager.connectOperationInProgress) {
        log(`关闭现有的WebSocket连接...`);
        this.wsManager.closeWebSocket();
      }
      
      // 重置WebSocket管理器的状态
      this.wsManager.resetConnectionState();
      log(`重置WebSocket连接状态，准备建立新连接`);
    } else {
      // 只有在没有WebSocketManager实例时才创建新实例
      log(`创建新的WebSocketManager实例`);
      this.wsManager = new WebSocketManager({
        wsUrl: this.config?.websocket?.url || 'wss://ws.backpack.exchange',
        config: this.config,
        onMessage: this.handleMessage.bind(this),
        onPriceUpdate: this.handleWebSocketPriceUpdate.bind(this),
        logger: this.logger
      });
    }
    
    // 设置连接超时 - 15秒后如果没有连接成功，尝试使用REST API
    this.clearAllTimeouts();
    this.wsConnectTimeout = setTimeout(() => {
      if (!this.lastUpdateTime) {
        log('WebSocket连接超时，尝试使用REST API获取价格');
        this.fetchPriceFromApi();
      }
    }, 15000);
    
    // 启动WebSocket
    log(`启动对 ${symbol} 的价格监控...`);
    const websocket = this.wsManager.setupPriceWebSocket(symbol);
    
    // 启动定期检查，确保价格数据正常
    this.startPeriodicCheck();
    
    return websocket !== null;
  }
  
  /**
   * 停止价格监控
   */
  stopMonitoring() {
    if (!this.monitoring) {
      return;
    }
    
    this.monitoring = false;
    
    // 停止定时检查
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    // 清理事件清理定时器
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // 清理超时定时器
    this.clearAllTimeouts();
    
    // 关闭WebSocket连接
    if (this.wsManager) {
      this.logger?.log('停止价格监控和WebSocket连接...');
      this.wsManager.closeAllConnections();
    }
    
    // 清理价格数据
    this.clearPriceData();
    
    this.logger?.log('价格监控已完全停止');
  }
  
  /**
   * 清理所有价格数据
   * 在重置应用状态时调用，确保不保留旧的价格数据
   */
  clearPriceData() {
    this.currentPrice = 0;
    this.lastPrice = 0;
    this.lastUpdateTime = null;
    this.priceSource = null;
    
    // 重置重启检测变量
    this.restartTime = null;
    
    // 清理WebSocketManager中的数据
    if (this.wsManager) {
      this.wsManager.lastPriceData = null;
    }
    
    // 清理已处理的价格事件记录
    this.processedPriceEvents.clear();
    
    this.logger?.log('价格数据已清理');
  }
  
  /**
   * 清除所有超时定时器
   */
  clearAllTimeouts() {
    if (this.wsConnectTimeout) {
      clearTimeout(this.wsConnectTimeout);
      this.wsConnectTimeout = null;
    }
    
    if (this.initialDataTimeout) {
      clearTimeout(this.initialDataTimeout);
      this.initialDataTimeout = null;
    }
  }
  
  /**
   * 启动定期检查
   */
  startPeriodicCheck() {
    // 清除现有的定期检查
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    
    // 每10秒检查一次价格数据状态，降低间隔增加及时性
    this.checkInterval = setInterval(() => {
      this.checkPriceDataStatus();
    }, 10000);
    
    // 首次启动时立即执行一次检查
    setTimeout(() => {
      this.checkPriceDataStatus();
    }, 5000);
  }
  
  /**
   * 检查价格数据状态
   */
  checkPriceDataStatus() {
    if (!this.monitoring) return;
    
    const now = Date.now();
    
    // 添加WebSocket状态诊断
    const runTimeMinutes = Math.floor((now - this.startMonitoringTime) / 60000);
    
    // 每5分钟进行一次WebSocket连接状态检查和报告
    if (runTimeMinutes > 0 && runTimeMinutes % 5 === 0 && (now % 60000) < 10000) {
      if (this.wsManager) {
        this.wsManager.reportConnectionStatus();
      }
    }
    
    // 检测多重连接问题
    if (this.wsManager && this.wsManager.activeConnectionCount > 1) {
      this.logger.log(`发现多个活跃的WebSocket连接(${this.wsManager.activeConnectionCount})，进行清理...`, true);
      // 先关闭所有连接，然后重置状态
      this.wsManager.closeAllConnections();
      this.wsManager.resetConnectionState();
      
      // 等待3秒后重新建立连接，避免快速重连可能导致的更多问题
      setTimeout(() => {
        if (this.monitoring) {
          this.logger.log(`重新建立单一WebSocket连接...`);
          this.wsManager.setupPriceWebSocket(this.symbol);
        }
      }, 3000);
      
      // 跳过本次数据状态检查
      return;
    }
    
    // 如果有上次更新时间，检查价格数据是否过时
    if (this.lastUpdateTime) {
      const dataAge = now - this.lastUpdateTime;
      
      // 如果价格数据超过45秒未更新，记录警告并尝试使用REST API
      if (dataAge > 45000) {
        this.logger.log(`警告: 价格数据已 ${Math.floor(dataAge / 1000)} 秒未更新`, true);
        
        // 检查WebSocket连接和订阅状态
        const wsConnected = this.wsManager?.isConnected() || false;
        const wsSubscribed = this.wsManager?.subscriptionState?.isSubscribed || false;
        const wsConnectInProgress = this.wsManager?.connectOperationInProgress || false;
        
        // 定义明确的数据获取策略:
        if (!wsConnected) {
          this.logger.log('WebSocket未连接，尝试使用REST API并重新建立WebSocket连接');
          // 先通过API获取数据，确保价格更新不被中断
          this.fetchPriceFromApi();
          
          // 检查是否可以重新连接(避免重复操作)
          if (!wsConnectInProgress) {
            this.logger.log('尝试重新建立WebSocket连接...');
            this.wsManager.setupPriceWebSocket(this.symbol);
          } else {
            this.logger.log('WebSocket连接操作正在进行中，等待完成...');
          }
        } 
        // WebSocket已连接但未订阅
        else if (wsConnected && !wsSubscribed && !wsConnectInProgress) {
          this.logger.log('WebSocket已连接但未订阅，尝试重新订阅');
          this.wsManager.subscribeTicker(this.symbol);
          // 同时通过API获取数据作为备份
          this.fetchPriceFromApi();
        }
        // WebSocket已连接且已订阅，但数据仍然过时(超过60秒)
        else if (dataAge > 60000) {
          this.logger.log('WebSocket连接状态正常但数据过期，尝试通过REST API获取价格');
          this.fetchPriceFromApi();
          
          // 考虑重置WebSocket连接
          if (dataAge > 120000 && !wsConnectInProgress) {
            this.logger.log('数据严重过期(2分钟)，尝试重置WebSocket连接');
            this.wsManager.closeWebSocket();
            setTimeout(() => {
              if (this.monitoring) {
                this.wsManager.setupPriceWebSocket(this.symbol);
              }
            }, 3000); // 延迟3秒后重连，避免立即重连可能导致的问题
          }
        }
      }
    }
    else {
      // 如果没有上次更新时间，可能是首次启动或数据未初始化
      const startupTime = now - this.startMonitoringTime;
      
      // 如果启动后20秒还没有收到数据，尝试通过REST API获取价格
      if (startupTime > 20000) {
        this.logger.log('WebSocket无法获取初始价格数据，尝试通过REST API获取');
        this.fetchPriceFromApi();
        
        // 检查WebSocket状态，必要时尝试重连
        const wsConnected = this.wsManager?.isConnected() || false;
        const wsSubscribed = this.wsManager?.subscriptionState?.isSubscribed || false;
        const wsConnectInProgress = this.wsManager?.connectOperationInProgress || false;
        
        // 如果启动后45秒还没有WebSocket连接或订阅
        if (startupTime > 45000) {
          if (!wsConnected && !wsConnectInProgress) {
            this.logger.log('WebSocket长时间未连接，尝试重新建立连接');
            this.wsManager.closeWebSocket();
            this.wsManager.setupPriceWebSocket(this.symbol);
          }
          else if (wsConnected && !wsSubscribed && !wsConnectInProgress) {
            this.logger.log('WebSocket已连接但未订阅，尝试重新订阅');
            this.wsManager.subscribeTicker(this.symbol);
          }
        }
      }
    }
    
    // 即使WebSocket正常，也定期通过REST API检查价格，确保数据可靠性
    // 但增加了连续失败次数检查，如果频繁失败会降低请求频率
    if (this.restApiEnabled && (now - this.lastRestApiCheck > this.restApiInterval)) {
      // 根据连续失败次数调整实际检查间隔
      let actualInterval = this.restApiInterval;
      if (this.restApiConsecutiveFailures >= this.maxConsecutiveFailures) {
        // 如果连续失败次数达到阈值，延长间隔至3分钟
        actualInterval = 180000; // 3分钟
      } else if (this.restApiConsecutiveFailures > 2) {
        // 如果连续失败2次以上，延长间隔至2分钟
        actualInterval = 120000; // 2分钟
      }
      
      if (now - this.lastRestApiCheck > actualInterval) {
        this.lastRestApiCheck = now;
        // 低调地获取REST API价格，不记录过多日志
        this.fetchPriceFromApi(true);
      }
    }
  }
  
  /**
   * 处理WebSocket消息
   * @param {Object} data - 消息数据
   */
  handleMessage(data) {
    try {
      // 只有0.1%的消息会被记录到日志文件，大幅减少日志量
      if (Math.random() < 0.001 && typeof this.logger?.logToFile === 'function') {
        this.logger.logToFile(`收到WebSocket消息: ${JSON.stringify(data).substring(0, 200)}...`);
      }
      
      // 将原始消息传递给外部处理函数
      if (typeof this.onPriceData === 'function') {
        this.onPriceData(data);
      }
    } catch (error) {
      if (typeof this.logger?.log === 'function') {
        this.logger.log(`处理WebSocket消息失败: ${error.message}`);
      } else {
        console.log(`处理WebSocket消息失败: ${error.message}`);
      }
    }
  }
  
  /**
   * 处理WebSocket价格更新回调
   * @param {Object|string} priceInfo - 价格信息对象或交易对符号
   * @param {number|Date} priceOrTime - 价格或时间对象
   * @param {Date} [timeArg] - 时间戳(可选)
   */
  handleWebSocketPriceUpdate(priceInfo, priceOrTime, timeArg) {
    try {
      let symbol, price, time;
      
      // 检查参数类型，兼容新旧两种调用方式
      if (typeof priceInfo === 'object' && priceInfo !== null && priceInfo.price !== undefined) {
        // 新格式：priceInfo是一个包含price的对象
        symbol = priceInfo.symbol;
        price = priceInfo.price;
        time = priceOrTime instanceof Date ? priceOrTime : new Date();
      } else {
        // 旧格式：独立参数
        symbol = priceInfo;
        price = priceOrTime;
        time = timeArg instanceof Date ? timeArg : new Date();
      }
      
      // 确保参数有效
      if (!symbol || !price || isNaN(price) || price <= 0) {
        this.logger?.log(`收到无效的WebSocket价格更新: symbol=${symbol}, price=${price}`);
        return;
      }
      
      // 获取原始数据对象以进行事件去重
      const rawData = priceInfo && priceInfo.raw ? priceInfo.raw : null;
      
      // 基于事件时间戳的去重逻辑
      if (rawData && rawData.E) {
        const eventId = `${rawData.e || 'ticker'}_${rawData.s || symbol}_${rawData.E}`;
        
        // 检查这个事件是否已经处理过
        if (this.processedPriceEvents.has(eventId)) {
          // 已处理过的事件，忽略
          return;
        }
        
        // 标记此事件为已处理
        this.processedPriceEvents.set(eventId, Date.now());
      }
      
      // 清除初始连接超时
      this.clearAllTimeouts();
      
      // 增强的价格处理去重逻辑
      const now = Date.now();
      const timeStamp = time ? time.getTime() : now;
      
      // 检查是否是相同价格的频繁更新（特别是重启后）
      if (this.currentPrice > 0 && price === this.currentPrice) {
        // 如果价格完全相同，增加频率控制
        const timeSinceLastUpdate = now - (this.lastUpdateTime || 0);
        
        // 重启后的5秒内，对相同价格的更新进行严格控制，最多每1秒处理一次
        const isPostRestartPeriod = this.restartTime && (now - this.restartTime < 5000);
        if (isPostRestartPeriod) {
          if (timeSinceLastUpdate < 1000) { // 重启后1秒内的相同价格不处理
            return;
          }
        } else if (timeSinceLastUpdate < 500) { // 正常状态下500毫秒内的相同价格不处理
          return;
        }
      }
      
      // 记录价格更新
      const isFirstUpdate = !this.currentPrice || this.currentPrice <= 0;
      
      // 重启标记 - 当从无价格状态转为有价格状态时，认为可能是重启后
      if (isFirstUpdate) {
        this.restartTime = now;
        this.logger?.log('检测到可能的重启后首次价格更新，启用价格去重保护机制');
      }
      
      // 更新内部状态
      this.lastPrice = this.currentPrice;
      this.currentPrice = price;
      this.lastUpdateTime = timeStamp;
      this.priceSource = 'WebSocket';
      
      // 调用价格更新回调
      this.handlePriceUpdate(price, symbol);
    } catch (error) {
      this.logger?.log(`处理WebSocket价格更新失败: ${error.message}`);
    }
  }
  
  /**
   * 处理价格更新
   * @param {number} price - 价格
   * @param {string} symbol - 交易对符号
   * @param {string} source - 数据来源
   */
  handlePriceUpdate(price, symbol, source = this.priceSource) {
    try {
      // 确保价格有效
      if (!this.isPriceValid(price)) {
        return;
      }
      
      // 增加时间控制，避免太频繁的更新
      const now = Date.now();
      const minUpdateInterval = 100; // 最小更新间隔100毫秒
      
      // 如果上次更新时间存在，检查是否间隔足够
      if (this.lastUpdateTime && (now - this.lastUpdateTime < minUpdateInterval)) {
        // 更新太频繁，忽略此次更新
        return;
      }
      
      // 构建价格信息对象
      const priceInfo = {
        symbol: symbol || this.symbol,
        price: price,
        source: source,
        time: new Date(),
        prev: this.lastPrice,
        change: this.lastPrice > 0 ? (price - this.lastPrice) / this.lastPrice : 0
      };
      
      // 调用外部回调
      if (typeof this.onPriceUpdate === 'function') {
        this.onPriceUpdate(priceInfo);
      } else {
        this.logger?.log('警告: 未设置价格更新回调函数');
      }
    } catch (error) {
      this.logger?.log(`处理价格更新失败: ${error.message}`);
    }
  }
  
  /**
   * 获取当前价格信息
   * @returns {Object|null} 价格信息对象
   */
  getCurrentPriceInfo() {
    if (!this.currentPrice || !this.isPriceValid(this.currentPrice)) {
      return null;
    }
    
    return {
      symbol: this.symbol,
      price: this.currentPrice,
      time: this.lastUpdateTime ? new Date(this.lastUpdateTime) : new Date(),
      source: this.priceSource
    };
  }
  
  /**
   * 检查价格数据是否有效
   * @param {number} timeoutSeconds - 超时时间（秒）
   * @returns {boolean} 数据是否有效
   */
  isPriceDataValid(timeoutSeconds = 60) {
    if (!this.currentPrice || !this.isPriceValid(this.currentPrice)) {
      return false;
    }
    
    if (!this.lastUpdateTime) {
      return false;
    }
    
    const dataAge = Date.now() - this.lastUpdateTime;
    return dataAge <= (timeoutSeconds * 1000);
  }
  
  /**
   * 检查是否正在监控
   * @returns {boolean} 是否正在监控
   */
  isMonitoring() {
    return this.monitoring;
  }
  
  /**
   * 判断价格是否有效
   * @param {number} price - 价格
   * @returns {boolean} 是否有效
   */
  isPriceValid(price) {
    return !isNaN(price) && price > 0;
  }
  
  /**
   * 通过REST API获取价格
   * @param {boolean} silent - 是否静默模式（不记录详细日志）
   */
  async fetchPriceFromApi(silent = false) {
    try {
      // 阻止频繁API调用，确保最小间隔为5秒
      const now = Date.now();
      const minApiCallInterval = 5000; // 最小API调用间隔5秒
      
      if (this.lastRestApiCheck && (now - this.lastRestApiCheck < minApiCallInterval)) {
        // API调用太频繁，忽略此次请求
        return;
      }
      
      // 更新最后API检查时间
      this.lastRestApiCheck = now;
      
      if (!silent) {
        this.logger?.log(`尝试通过REST API获取${this.symbol}价格...`);
      }
      
      // 首先尝试Backpack API
      try {
        const response = await axios.get(`${this.restApiBaseUrl}/api/v1/ticker`, {
          params: { symbol: this.symbol },
          timeout: 8000 // 从5秒增加到8秒超时
        });
        
        if (response.data && response.data.lastPrice) {
          const price = parseFloat(response.data.lastPrice);
          
          if (this.isPriceValid(price)) {
            // 添加日志记录控制 - 价格变化超过1%或30秒内未记录过才记录
            const priceChanged = this.currentPrice && Math.abs((price - this.currentPrice) / this.currentPrice) >= 0.01;
            const timeElapsed = !this.lastApiLogTime || (now - this.lastApiLogTime > 30000);
            
            if (!silent && (priceChanged || timeElapsed)) {
              this.logger?.log(`从Backpack REST API获取到价格: ${price}`);
              this.lastApiLogTime = now;
            }
            
            // 更新状态
            this.lastPrice = this.currentPrice;
            this.currentPrice = price;
            this.lastUpdateTime = now;
            this.priceSource = 'Backpack REST';
            
            // 重置连续失败计数
            this.restApiConsecutiveFailures = 0;
            
            // 触发价格更新 - 创建一个带有唯一标识符的"伪"事件ID
            const apiEventId = `restapi_${this.symbol}_${now}`;
            
            // 检查是否已经处理过这个价格（近似检查，避免短时间内重复触发）
            if (!this.processedPriceEvents.has(apiEventId)) {
              // 标记为已处理
              this.processedPriceEvents.set(apiEventId, now);
              
              // 触发价格更新回调
              this.handlePriceUpdate(price, this.symbol, 'Backpack REST');
            }
            
            return price;
          }
        }
        throw new Error('获取到的价格数据无效');
      } catch (backpackError) {
        // Backpack API失败，尝试Binance API
        if (!silent) {
          this.logger?.log(`Backpack REST API失败: ${backpackError.message}, 尝试Binance API`);
        }
        
        // 转换交易对格式
        const binanceSymbol = this.symbol.replace('_', '');
        
        const response = await axios.get(`${this.binanceApiBaseUrl}/api/v3/ticker/price`, {
          params: { symbol: binanceSymbol },
          timeout: 8000 // 从5秒增加到8秒超时
        });
        
        if (response.data && response.data.price) {
          const price = parseFloat(response.data.price);
          
          if (this.isPriceValid(price)) {
            // 添加日志记录控制 - 同样的条件
            const priceChanged = this.currentPrice && Math.abs((price - this.currentPrice) / this.currentPrice) >= 0.01;
            const timeElapsed = !this.lastApiLogTime || (now - this.lastApiLogTime > 30000);
            
            if (!silent && (priceChanged || timeElapsed)) {
              this.logger?.log(`从Binance REST API获取到价格: ${price}`);
              this.lastApiLogTime = now;
            }
            
            // 更新状态
            this.lastPrice = this.currentPrice;
            this.currentPrice = price;
            this.lastUpdateTime = now;
            this.priceSource = 'Binance REST';
            this.usingFallbackApi = true;
            
            // 重置连续失败计数
            this.restApiConsecutiveFailures = 0;
            
            // 触发价格更新 - 创建一个带有唯一标识符的"伪"事件ID
            const apiEventId = `binanceapi_${this.symbol}_${now}`;
            
            // 检查是否已经处理过这个价格（近似检查，避免短时间内重复触发）
            if (!this.processedPriceEvents.has(apiEventId)) {
              // 标记为已处理
              this.processedPriceEvents.set(apiEventId, now);
              
              // 触发价格更新回调
              this.handlePriceUpdate(price, this.symbol, 'Binance REST');
            }
            
            return price;
          }
        }
        throw new Error('Binance API返回的价格数据无效');
      }
    } catch (error) {
      // 增加连续失败计数
      this.restApiConsecutiveFailures++;
      
      // 记录错误和失败次数
      this.logger?.log(`通过REST API获取价格失败 (连续第${this.restApiConsecutiveFailures}次): ${error.message}`, true);
      
      // 根据连续失败次数动态调整下次请求延迟
      if (this.restApiConsecutiveFailures > 1) {
        // 使用指数退避策略，延长lastRestApiCheck时间
        const additionalDelay = Math.min(
          300000, // 最多额外延长5分钟
          this.restApiRetryInterval * Math.pow(1.5, this.restApiConsecutiveFailures - 1)
        );
        
        // 更新最后检查时间，延迟下次请求
        this.lastRestApiCheck = Date.now() + additionalDelay - this.restApiInterval;
        
        this.logger?.log(`由于连续失败，下次REST API请求将延迟 ${Math.round(additionalDelay/1000)} 秒`, true);
      }
      
      return null;
    }
  }
}

module.exports = PriceMonitor; 