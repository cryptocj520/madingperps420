const WebSocket = require('ws');
const { defaultLogger } = require('../utils/logger');

/**
 * WebSocket管理器类 - 负责处理与交易所的WebSocket连接
 */
class WebSocketManager {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {Object} options.config - 配置对象
   * @param {Object} options.logger - 日志记录器
   * @param {Function} options.onMessage - 消息处理回调
   * @param {Function} options.onPrice - 价格更新回调
   */
  constructor(options = {}) {
    // 优先使用配置中的WebSocket URL，然后是选项中的URL，最后使用默认值
    this.wsUrl = options.config?.websocket?.url || options.wsUrl || 'wss://ws.backpack.exchange';
    this.config = options.config || {};
    this.ws = null;
    this.connectionActive = false;
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.logger = options.logger || console;
    this.onMessage = options.onMessage || (() => {});
    
    // 修复onPriceUpdate回调 - 确保正确设置
    this.onPriceUpdate = options.onPriceUpdate || (() => {});
    
    // 验证和记录回调函数设置情况
    if (typeof this.onPriceUpdate === 'function') {
      this.logger.log('WebSocketManager: onPriceUpdate回调已设置');
    } else {
      this.logger.log('警告: WebSocketManager.onPriceUpdate未正确设置');
    }
    
    // 价格更新控制
    this.lastLoggedPrice = null;
    this.lastLogTime = 0;
    this.logThrottleMs = 5000; // 每5秒最多记录一次价格
    this.logPriceChange = 0.05; // 记录百分比变化超过5%的价格
    
    // 记录控制
    this.shouldLog = true;
    this.logHeartbeats = false;
    
    // 日志采样率控制
    this.messageSampleRate = 0.01; // 1%的消息会被记录
    this.priceSampleRate = 0.005; // 0.5%的价格更新会被记录到文件
    this.debugMode = false; // 默认关闭调试模式
    
    // 添加数据缓存
    this.lastPriceData = null;
    
    // 添加重连控制
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5; // 最多尝试5次重连
    this.baseReconnectDelay = 5000; // 基础重连延迟5秒
    this.failedToConnect = false; // 跟踪是否连接失败
    this.lastConnectTime = 0; // 上次连接尝试时间
    
    // 连接唯一性控制
    this.connectionId = 0; // 当前连接的ID
    this.connectOperationInProgress = false; // 是否有连接操作正在进行
    this.pendingConnection = false; // 是否有挂起的连接请求
    this.lastCloseTime = 0; // 上次连接关闭时间
    this.maxSimultaneousConnections = 1; // 允许的最大同时连接数
    this.activeConnectionCount = 0; // 当前活动连接数
    
    // 新增心跳相关属性
    this.lastHeartbeatResponse = Date.now(); // 初始化为当前时间
    this.lastHeartbeatSent = Date.now(); // 初始化为当前时间
    this.lastResponseTime = Date.now(); // 初始化为当前时间
    this.heartbeatFailures = 0;
    this.heartbeatIntervalMs = 30000; // 30秒发送一次心跳
    this.heartbeatTimeoutMs = 90000; // 90秒没有响应视为超时
    this.maxHeartbeatFailures = 3; // 3次心跳失败后重连
    
    // 新增备用格式尝试控制
    this.backupFormatAttempt = 0;
    
    // 订阅状态控制
    this.subscriptionState = {
      lastAttemptTime: 0,          // 上次尝试订阅的时间
      attemptCount: 0,             // 当前订阅尝试次数
      currentFormatIndex: 0,       // 当前使用的格式索引
      isSubscribed: false,         // 是否已成功订阅
      minRetryInterval: 3000,      // 最小重试间隔(毫秒)
      maxAttempts: 5              // 每种格式的最大尝试次数
    };
    
    // 添加消息去重机制
    this.processedMessages = new Map(); // 用于存储已处理的消息ID
    this.maxProcessedMessages = 1000;   // 最多保存1000条消息记录
    this.messageCleanupInterval = null; // 清理定时器
    
    // 启动定期清理过期消息记录的定时器
    this.setupMessageCleanup();
  }
  
  /**
   * 重置日志控制参数
   */
  resetLogControl() {
    this.lastLoggedPrice = null;
    this.lastLogTime = 0;
  }
  
  /**
   * 设置价格WebSocket连接
   * @param {string} symbol - 交易对符号
   */
  setupPriceWebSocket(symbol) {
    // 保存交易对符号，用于重连
    this.symbol = symbol;
    
    // 第一步：详细输出当前WebSocket连接状态
    this.logger.log(`===== WebSocket连接状态检查 =====`);
    this.logger.log(`- WebSocket对象存在: ${this.ws ? '是' : '否'}`);
    this.logger.log(`- 活跃连接计数: ${this.activeConnectionCount}`);
    if (this.ws) {
      const wsStateText = this.ws.readyState === WebSocket.CONNECTING ? "正在连接" : 
                          this.ws.readyState === WebSocket.OPEN ? "已连接" : 
                          this.ws.readyState === WebSocket.CLOSING ? "正在关闭" : "已关闭";
      this.logger.log(`- WebSocket连接状态: ${wsStateText} (${this.ws.readyState})`);
    }
    this.logger.log(`- 连接操作标记: ${this.connectOperationInProgress ? '正在进行' : '无'}`);
    this.logger.log(`- 连接ID: ${this.connectionId}`);
    
    // 检查是否已有活跃连接且状态正常
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.activeConnectionCount > 0) {
      this.logger.log(`检测到有效的WebSocket连接，无需重新连接`);
      
      // 如果已订阅，确认订阅状态
      if (this.subscriptionState.isSubscribed) {
        this.logger.log(`当前连接已订阅 ${symbol}，无需重复订阅`);
        return this.ws;
      } else {
        // 如果连接已建立但未订阅，直接订阅并返回
        this.logger.log(`连接已建立但未订阅，现在订阅 ${symbol}`);
        this.subscribeTicker(symbol);
        return this.ws;
      }
    }
    
    // 如果有正在关闭的连接，等待其完成
    if (this.ws && this.ws.readyState === WebSocket.CLOSING) {
      this.logger.log(`当前WebSocket连接正在关闭，等待关闭完成后再建立新连接...`);
      this.pendingConnection = true;
      
      // 设置一个短延迟后再次尝试连接
      setTimeout(() => {
        if (this.pendingConnection) {
          this.logger.log(`重新尝试建立WebSocket连接...`);
          this.pendingConnection = false;
          this.setupPriceWebSocket(symbol);
        }
      }, 1000);
      return null;
    }
    
    // 如果正在建立连接中，避免重复操作
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.logger.log(`WebSocket连接正在建立中，等待连接完成...`);
      return this.ws;
    }
    
    // 第一步：确保没有任何活跃的WebSocket连接
    // 添加强制关闭所有现有连接的逻辑
    if (this.ws || this.activeConnectionCount > 0) {
      this.logger.log(`检测到现有WebSocket连接，在创建新连接前关闭所有现有连接...`);
      this.closeAllConnections(); // 使用现有方法关闭所有连接并重置状态
      
      // 额外检查，确保连接已关闭
      if (this.ws) {
        try {
          this.logger.log(`额外检查: WebSocket对象仍然存在，进行强制终止...`);
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.terminate();
            this.logger.log(`强制终止未完全关闭的WebSocket连接`);
          }
          this.ws = null;
          this.logger.log(`WebSocket对象已清空`);
        } catch (error) {
          this.logger.log(`强制关闭WebSocket出错: ${error.message}`);
          this.ws = null;
        }
      }
      
      // 确保计数器归零
      this.activeConnectionCount = 0;
      this.logger.log(`活跃连接计数已重置为0`);
    } else {
      this.logger.log(`没有检测到现有WebSocket连接，可以直接创建新连接`);
    }
    
    // 如果已经有连接操作在进行中，则不再启动新的连接
    if (this.connectOperationInProgress) {
      this.logger.log(`已有WebSocket连接操作在进行中，跳过此次连接请求`);
      this.pendingConnection = true;
      return null;
    }
    
    // 确认没有任何活跃连接后再继续
    this.logger.log(`✓ 确认无活跃WebSocket连接，开始建立新连接...`);
    
    // 标记连接操作为进行中
    this.connectOperationInProgress = true;
    
    // 生成唯一的连接ID，用于跟踪当前连接
    const currentConnectionId = ++this.connectionId;
    this.logger.log(`开始建立WebSocket连接 #${currentConnectionId} 到 ${this.wsUrl}...`);
    
    // 记录本次连接尝试时间
    this.lastConnectTime = Date.now();
    
    // 重置活动连接计数，确保从1开始
    this.activeConnectionCount = 1;
    
    // 继续执行安装新的WebSocket连接的代码...
    
    try {
      // 创建WebSocket连接
      this.ws = new WebSocket(this.wsUrl);
      
      // 设置连接超时
      const connectionTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.logger.log(`WebSocket连接 #${currentConnectionId} 超时`);
          if (this.ws) {
            this.ws.terminate();
            this.ws = null;
          }
          this.activeConnectionCount = 0;  // 重置活动连接计数
          this.connectOperationInProgress = false; // 重置操作标志
          this.handleReconnect(symbol);
        }
      }, 10000); // 10秒连接超时
      
      // 连接打开时的处理
      this.ws.on('open', () => {
        // 检查是否为当前的连接ID
        if (currentConnectionId !== this.connectionId) {
          this.logger.log(`忽略旧的WebSocket连接 #${currentConnectionId} 的open事件 (当前ID: ${this.connectionId})`);
          try {
            this.ws.terminate();
            this.activeConnectionCount--;  // 减少活动连接计数
          } catch (error) {
            this.logger.log(`关闭过时连接时出错: ${error.message}`);
          }
          return;
        }
        
        clearTimeout(connectionTimeout);
        this.connectionActive = true;
        this.connectOperationInProgress = false; // 重置操作标志
        this.logger.log(`WebSocket连接 #${currentConnectionId} 已建立`);
        this.reconnectAttempts = 0; // 重置重连计数
        this.failedToConnect = false;
        
        // 检查活动连接数是否超过限制
        if (this.activeConnectionCount > this.maxSimultaneousConnections) {
          this.logger.log(`警告: 检测到 ${this.activeConnectionCount} 个活动WebSocket连接，超过限制 (${this.maxSimultaneousConnections})`);
        }
        
        // 修改: 使用与test_websocket2.js相同的标准格式订阅行情
        this.subscribeTicker(symbol);
        
        // 设置心跳
        this.setupHeartbeat();
        
        // 处理挂起的连接请求
        if (this.pendingConnection) {
          this.pendingConnection = false;
          this.logger.log('已处理挂起的连接请求，无需创建新连接');
        }
      });
      
      // 接收消息时的处理
      this.ws.on('message', (data) => {
        // 检查是否为当前的连接ID
        if (currentConnectionId !== this.connectionId) {
          return; // 忽略旧连接的消息
        }
        
        try {
          const now = new Date();
          let message = {};
          
          try {
            // 确保data是字符串
            const dataStr = data instanceof Buffer ? data.toString() : 
                          typeof data === 'string' ? data : 
                          JSON.stringify(data);
            
            message = JSON.parse(dataStr);
            // 尝试从data中获取数据，可能是多种不同格式
            this.processMessage(message, symbol, now);
          } catch (parseError) {
            this.logger.log(`解析WebSocket消息失败: ${parseError.message}`);
            return;
          }
          
          // 调用消息回调
          if (typeof this.onMessage === 'function') {
            this.onMessage(message);
          }
        } catch (error) {
          this.logger.log(`处理WebSocket消息错误: ${error.message}`);
        }
      });
      
      // 连接关闭时的处理
      this.ws.on('close', (code, reason) => {
        // 检查是否为当前的连接ID
        if (currentConnectionId !== this.connectionId) {
          this.logger.log(`忽略旧的WebSocket连接 #${currentConnectionId} 的close事件 (当前ID: ${this.connectionId})`);
          return;
        }
        
        clearTimeout(connectionTimeout);
        this.connectionActive = false;
        this.activeConnectionCount--;  // 减少活动连接计数
        this.lastCloseTime = Date.now();
        this.connectOperationInProgress = false; // 重置操作标志
        
        this.logger.log(`WebSocket连接 #${currentConnectionId} 已关闭, 代码: ${code}, 原因: ${reason || '未知'}`);
        
        // 清理心跳
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        
        // 处理重连
        this.handleReconnect(symbol);
      });
      
      // 错误处理
      this.ws.on('error', (error) => {
        // 检查是否为当前的连接ID
        if (currentConnectionId !== this.connectionId) {
          this.logger.log(`忽略旧的WebSocket连接 #${currentConnectionId} 的error事件`);
          return;
        }
        
        this.logger.log(`WebSocket连接 #${currentConnectionId} 错误: ${error.message}`);
        // 不在这里处理重连，等待关闭事件
      });
      
      return this.ws;
    } catch (error) {
      this.logger.log(`建立WebSocket连接 #${currentConnectionId} 失败: ${error.message}`);
      this.connectOperationInProgress = false; // 重置操作标志
      this.activeConnectionCount--;  // 减少活动连接计数
      this.handleReconnect(symbol);
      return null;
    }
  }
  
  /**
   * 处理重连逻辑
   * @param {string} symbol - 交易对符号 
   */
  handleReconnect(symbol) {
    // 如果已经在等待重连，则不需要再次触发
    if (this.reconnectTimeout) {
      this.logger.log(`已有重连操作在等待中，跳过本次重连请求`);
      return;
    }
    
    // 如果重连次数达到上限，则不再尝试
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.log(`已达到最大重连次数(${this.maxReconnectAttempts})，停止重连`);
      this.failedToConnect = true;
      return;
    }
    
    // 增加重连尝试次数
    this.reconnectAttempts++;
    
    // 使用指数退避计算重连延迟时间，防止频繁重连
    const baseDelay = this.reconnectDelay || 5000;
    const delay = Math.min(
      baseDelay * Math.pow(1.5, this.reconnectAttempts - 1),
      60000 // 最大延迟60秒
    );
    
    this.logger.log(`计划在${Math.round(delay/1000)}秒后尝试重连(第${this.reconnectAttempts}次)...`);
    
    // 设置重连超时
    this.reconnectTimeout = setTimeout(() => {
      // 清除重连超时引用
      this.reconnectTimeout = null;
      
      // 重置连接操作标志，确保可以开始新的连接
      this.connectOperationInProgress = false;
      
      // 避免在已有连接的情况下重连
      if (this.isConnected()) {
        this.logger.log(`跳过WebSocket重连，因为已有活动连接`);
        return;
      }
      
      // 确认是否需要重置订阅状态
      // 如果距离上次连接关闭已经超过30秒，认为是新的连接周期，重置订阅状态
      if (Date.now() - this.lastCloseTime > 30000) {
        this.logger.log(`距离上次连接关闭已超过30秒，重置订阅状态`);
        this.subscriptionState.isSubscribed = false;
      }
      
      this.setupPriceWebSocket(symbol);
    }, delay);
  }
  
  /**
   * 处理接收到的消息
   * @param {Object} message - 解析后的消息对象
   * @param {string} symbol - 交易对符号
   * @param {Date} now - 当前时间
   */
  processMessage(message, symbol, now) {
    if (!message || !message.data) {
      return;
    }
    
    const currentTime = Date.now();
    let priceData = null;
    let tickerSymbol = null;
    
    try {
      // 判断message.data的类型，如果已经是对象则直接使用，否则尝试解析
      priceData = typeof message.data === 'object' ? message.data : JSON.parse(message.data);
      
      // 消息去重处理 - 使用事件时间戳E作为唯一标识符
      if (priceData.E) {
        const messageId = `${priceData.e || 'unknown'}_${priceData.s || 'unknown'}_${priceData.E}`;
        
        // 检查这个消息是否已经处理过
        if (this.processedMessages.has(messageId)) {
          // 已处理过的消息，忽略
          if (Math.random() < 0.01) { // 仅记录1%的重复消息，避免日志过多
            this.logger.log(`忽略重复消息: ${messageId}`);
          }
          return;
        }
        
        // 标记这个消息为已处理
        this.processedMessages.set(messageId, currentTime);
      }
      
      // 尝试从多种可能的字段获取符号信息
      tickerSymbol = priceData.symbol || priceData.s || (priceData.e === 'ticker' && message.symbol);
      
      // 如果仍然无法获取符号，尝试从消息中获取更多信息
      if (!tickerSymbol && priceData.e === 'ticker') {
        this.logger.log(`接收到ticker数据但无法确定交易对: ${JSON.stringify(priceData).substring(0, 150)}...`);
      }
    } catch (error) {
      // 修复message.data.substring不是函数的错误
      let messageStr = '';
      try {
        if (typeof message.data === 'string') {
          messageStr = message.data.substring(0, 100);
        } else if (message.data) {
          messageStr = JSON.stringify(message.data).substring(0, 100);
        } else {
          messageStr = JSON.stringify(message).substring(0, 100);
        }
      } catch (subError) {
        messageStr = '无法显示消息内容';
      }
      this.logger.log(`解析WebSocket消息失败: ${error.message}, 消息: ${messageStr}...`);
      return;
    }
    
    // 更新上次响应时间
    this.lastResponseTime = currentTime;
    
    // 处理订阅确认
    if (message.type === 'subscribed' || 
        (message.channel === 'ticker' && message.type === 'update') ||
        // Backpack订阅确认格式
        (priceData.id && priceData.result === null) ||
        (priceData.method === 'SUBSCRIBE' && priceData.id)) {
      if (this.subscriptionState.pendingSubscription) {
        this.logger.log(`订阅成功确认: ${JSON.stringify(message)}`);
        this.subscriptionState.pendingSubscription = false;
        this.subscriptionState.subscribed = true;
        this.subscriptionState.lastSubscribedTime = currentTime;
      }
    }

    // 处理错误消息
    if (message.error) {
      this.logger.log(`WebSocket错误: ${JSON.stringify(message)}`, true);
      return;
    }
    
    // 统一处理价格更新消息，防止多次触发回调
    let isTickerMatch = false;
    let priceInfo = null;
    
    // 检查第一种匹配条件：symbol直接匹配
    if (this.symbol && tickerSymbol && this.symbol.toLowerCase() === tickerSymbol.toLowerCase()) {
      isTickerMatch = true;
      
      // 更新最后价格数据
      this.lastPriceData = priceData;
      
      // 价格更新日志控制
      if (this.priceUpdateLoggingRate < 1) {
        if (Math.random() < this.priceUpdateLoggingRate) {
          this.logger.log(`价格更新 [抽样${this.priceUpdateLoggingRate * 100}%]: ${JSON.stringify(priceData)}`);
        }
      } else {
        this.logger.log(`价格更新: ${JSON.stringify(priceData)}`);
      }
      
      // 构造价格信息对象
      priceInfo = {
        symbol: tickerSymbol,
        price: parseFloat(priceData.price || priceData.c || priceData.lastPrice),
        time: now,
        raw: priceData // 保留原始数据供处理
      };
    } 
    // 检查第二种匹配条件：Backpack ticker格式
    else if (priceData.e === 'ticker' && !isTickerMatch) {
      // 尝试从其他字段中查找交易对信息
      const backpackSymbol = priceData.s || '';
      const normalizedSymbol = backpackSymbol.replace('_', '').toLowerCase();
      const normalizedConfigSymbol = this.symbol.replace('_', '').toLowerCase();
      
      // 检查是否匹配当前交易对
      if (normalizedSymbol === normalizedConfigSymbol) {
        isTickerMatch = true;
        this.logger.log(`识别到Backpack ticker数据: ${backpackSymbol}`);
        this.lastPriceData = priceData;
        
        // 构造价格信息对象
        priceInfo = {
          symbol: backpackSymbol,
          price: parseFloat(priceData.c || priceData.price || priceData.lastPrice),
          time: now,
          raw: priceData // 保留原始数据供处理
        };
      }
    }
    
    // 如果匹配到了价格信息，调用价格更新回调
    if (isTickerMatch && priceInfo && typeof this.onPriceUpdate === 'function') {
      this.onPriceUpdate(priceInfo, now);
    } 
    // 处理其他类型的消息
    else if (!isTickerMatch) {
      // 处理其他类型的消息
      if (this.messageLoggingRate < 1) {
        if (Math.random() < this.messageLoggingRate) {
          // 安全处理JSON字符串
          let messageStr = '';
          try {
            messageStr = JSON.stringify(message).substring(0, 150);
          } catch (error) {
            messageStr = '无法序列化消息内容';
          }
          this.logger.log(`其他WebSocket消息 [抽样${this.messageLoggingRate * 100}%]: ${messageStr}...`);
        }
      } else {
        // 安全处理JSON字符串
        let messageStr = '';
        try {
          messageStr = JSON.stringify(message).substring(0, 150);
        } catch (error) {
          messageStr = '无法序列化消息内容';
        }
        this.logger.log(`其他WebSocket消息: ${messageStr}...`);
      }
    }
  }
  
  /**
   * 发送交易对订阅请求
   * @param {string} symbol 交易对
   */
  subscribeTicker(symbol) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.log(`无法订阅行情：WebSocket连接未打开`);
      return;
    }
    
    try {
      // 格式化交易对，使用原始格式，因为Backpack需要使用正确的格式
      const formattedSymbol = symbol;
      
      // 使用Backpack交易所正确的订阅格式
      const subscription = {
        "method": "SUBSCRIBE",
        "params": [`ticker.${formattedSymbol}`],
        "id": Date.now()
      };
      
      // 记录订阅请求
      this.logger.log(`订阅行情: ${JSON.stringify(subscription)}`);
      
      // 更新订阅状态
      this.subscriptionState.pendingSubscription = true;
      this.subscriptionState.lastAttemptTime = Date.now();
      
      // 发送订阅请求
      this.ws.send(JSON.stringify(subscription));
      
      // 保存当前订阅的交易对
      this.symbol = symbol;
    } catch (error) {
      this.logger.log(`发送订阅请求失败: ${error.message}`);
    }
  }
  
  /**
   * 设置心跳机制
   */
  setupHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // 添加原生WebSocket pong事件监听
    if (this.ws) {
      this.ws.on('pong', () => {
        this.lastHeartbeatResponse = Date.now();
        this.heartbeatFailures = 0; // 重置心跳失败计数
        
        if (this.logHeartbeats) {
          this.logger.log(`接收到原生WebSocket pong响应`);
        }
      });
    }
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const now = Date.now();
        const timeSinceLastResponse = now - this.lastHeartbeatResponse;
        
        try {
          // 使用WebSocket原生ping帧，测试证明这是最有效的方法
          this.ws.ping();
          this.lastHeartbeatSent = now;
          
          if (this.logHeartbeats) {
            this.logger.log(`发送原生WebSocket ping帧`);
          }
          
          // 检查心跳失败情况
          if (timeSinceLastResponse > this.heartbeatTimeoutMs) {
            this.heartbeatFailures++;
            
            this.logger.log(`心跳超时 (${this.heartbeatFailures}/${this.maxHeartbeatFailures}): 上次响应时间=${new Date(this.lastHeartbeatResponse).toISOString()}`);
            
            // 如果心跳失败次数超过最大允许次数，重新连接
            if (this.heartbeatFailures >= this.maxHeartbeatFailures) {
              this.logger.log(`心跳失败次数超过最大允许次数 (${this.maxHeartbeatFailures})，尝试重新连接`);
              this.resetConnection();
            }
          }
        } catch (error) {
          this.logger.log(`发送心跳消息失败: ${error.message}`, true);
          this.heartbeatFailures++;
          
          // 如果心跳失败次数超过最大允许次数，重新连接
          if (this.heartbeatFailures >= this.maxHeartbeatFailures) {
            this.logger.log(`心跳失败次数超过最大允许次数 (${this.maxHeartbeatFailures})，尝试重新连接`);
            this.resetConnection();
          }
        }
      }
    }, this.heartbeatIntervalMs);
    
    this.logger.log(`心跳机制已设置 - 使用原生WebSocket ping/pong帧`);
  }
  
  /**
   * 强制重置连接
   * 用于处理心跳失败或连接状态不一致的情况
   */
  resetConnection() {
    try {
      this.logger.log('强制重置WebSocket连接...', true);
      
      // 关闭现有连接
      this.closeWebSocket();
      
      // 重置连接状态
      this.connectionActive = false;
      this.activeConnectionCount = 0;
      this.connectOperationInProgress = false;
      this.pendingConnection = false;
      
      // 停止所有计时器
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      
      // 重置订阅状态
      this.subscriptionState.isSubscribed = false;
      this.subscriptionState.attemptCount = 0;
      this.subscriptionState.lastAttemptTime = 0;
      this.subscriptionState.currentFormatIndex = 0;
      
      // 延迟5秒后重新连接
      setTimeout(() => {
        if (this.symbol) {
          this.logger.log('开始重新建立WebSocket连接...', true);
          this.setupPriceWebSocket(this.symbol);
        } else {
          this.logger.log('无法重新连接: 缺少交易对符号');
        }
      }, 5000);
    } catch (error) {
      this.logger.log(`重置连接失败: ${error.message}`, true);
    }
  }
  
  /**
   * 关闭WebSocket连接
   */
  closeWebSocket() {
    // 标记连接状态为非活动
    this.connectionActive = false;
    
    this.logger.log(`===== 开始关闭WebSocket连接 =====`);
    this.logger.log(`- 当前连接ID: ${this.connectionId}`);
    this.logger.log(`- 当前活跃连接计数: ${this.activeConnectionCount}`);
    
    // 清理心跳
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger.log(`- 心跳定时器已清理`);
    }
    
    // 清理重连定时器
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
      this.logger.log(`- 重连定时器已清理`);
    }
    
    // 清理消息记录清理定时器
    if (this.messageCleanupInterval) {
      clearInterval(this.messageCleanupInterval);
      this.messageCleanupInterval = null;
      this.logger.log(`- 消息清理定时器已清理`);
    }
    
    // 重置状态变量
    this.connectOperationInProgress = false;
    this.pendingConnection = false;
    
    // 记录当前的连接ID
    const closingConnectionId = this.connectionId;
    
    // 关闭连接
    if (this.ws) {
      try {
        const wsState = this.ws.readyState;
        const wsStateText = wsState === WebSocket.CONNECTING ? "正在连接" : 
                           wsState === WebSocket.OPEN ? "已连接" : 
                           wsState === WebSocket.CLOSING ? "正在关闭" : "已关闭";
        this.logger.log(`- 即将关闭的连接状态: ${wsStateText} (${wsState})`);
        
        // 移除所有事件监听器
        if (this.ws.removeAllListeners) {
          try {
            this.ws.removeAllListeners();
            this.logger.log(`- 已移除所有事件监听器`);
          } catch (error) {
            this.logger.log(`- 移除事件监听器失败: ${error.message}`);
          }
        }
        
        // 先尝试优雅地关闭
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close();
          this.logger.log(`WebSocket连接 #${closingConnectionId} 已正常关闭`);
        } else if (this.ws.readyState === WebSocket.CONNECTING) {
          // 如果连接正在建立中，则强制终止
          this.ws.terminate();
          this.logger.log(`WebSocket连接 #${closingConnectionId} 已终止`);
        } else {
          this.logger.log(`WebSocket连接 #${closingConnectionId} 已处于关闭状态，无需再关闭`);
        }
        
        // 确保资源被清理
        this.ws = null;
        this.logger.log(`- WebSocket对象引用已清除`);
        
        // 记录连接关闭时间
        this.lastCloseTime = Date.now();
        this.activeConnectionCount = 0; // 确保计数器归零
        this.logger.log(`- 活跃连接计数已归零: ${this.activeConnectionCount}`);
      } catch (error) {
        this.logger.log(`关闭WebSocket连接 #${closingConnectionId} 失败: ${error.message}`);
        // 确保引用被清除
        this.ws = null;
        this.activeConnectionCount = 0;
        this.logger.log(`- 尽管出错，WebSocket对象引用和活跃连接计数已强制重置`);
      }
    } else {
      this.logger.log(`- 无需关闭: WebSocket对象不存在`);
      this.activeConnectionCount = 0; // 确保计数器归零
    }
    
    // 重置订阅状态
    this.subscriptionState.isSubscribed = false;
    this.subscriptionState.pendingSubscription = false;
    this.subscriptionState.attemptCount = 0;
    
    this.logger.log(`===== WebSocket连接关闭完成 =====`);
  }
  
  /**
   * 检查WebSocket是否已连接
   * @returns {boolean} 连接状态
   */
  isConnected() {
    // 增强的连接检查：检查连接状态标志、WebSocket对象状态，以及心跳响应时间
    const wsValid = this.connectionActive && this.ws && this.ws.readyState === WebSocket.OPEN;
    
    // 如果WebSocket连接状态正常，还需要检查心跳响应
    if (wsValid && this.lastHeartbeatResponse) {
      const now = Date.now();
      const timeSinceLastResponse = now - this.lastHeartbeatResponse;
      
      // 如果超过90秒未收到心跳响应，则认为连接不良
      if (timeSinceLastResponse > 90000) {
        this.logger.log(`WebSocket连接可能不健康: ${Math.floor(timeSinceLastResponse/1000)}秒未收到心跳响应`);
        return false; // 返回未连接状态，促使系统重连
      }
    }
    
    return wsValid;
  }
  
  /**
   * 重置连接状态和重试计数
   */
  resetConnectionState() {
    this.logger.log(`===== 开始重置WebSocket连接状态 =====`);
    this.logger.log(`- 连接ID: ${this.connectionId}`);
    this.logger.log(`- 重连尝试次数: ${this.reconnectAttempts} -> 0`);
    this.logger.log(`- 连接失败标记: ${this.failedToConnect} -> false`);
    this.logger.log(`- 操作进行中标记: ${this.connectOperationInProgress} -> false`);
    this.logger.log(`- 挂起连接请求: ${this.pendingConnection} -> false`);
    this.logger.log(`- 活跃连接计数: ${this.activeConnectionCount} -> 0`);

    this.reconnectAttempts = 0;
    this.failedToConnect = false;
    this.lastConnectTime = 0;
    this.connectOperationInProgress = false;
    this.pendingConnection = false;
    this.activeConnectionCount = 0;
    
    // 重置订阅状态
    this.logger.log(`- 订阅状态: ${this.subscriptionState.isSubscribed ? '已订阅' : '未订阅'} -> 未订阅`);
    this.subscriptionState.isSubscribed = false;
    this.subscriptionState.attemptCount = 0;
    this.subscriptionState.lastAttemptTime = 0;
    this.subscriptionState.currentFormatIndex = 0;
    
    // 重置消息处理记录
    this.processedMessages.clear();
    
    // 重新设置消息清理定时器
    this.setupMessageCleanup();
    
    this.logger.log(`===== WebSocket连接状态重置完成 =====`);
  }
  
  /**
   * 处理价格更新 - 这个方法仍然保留作为备用
   * @param {string} tickerSymbol - 交易对符号
   * @param {number} lastPrice - 最新价格
   * @param {string} symbol - 订阅的交易对符号
   * @param {Date} now - 当前时间
   */
  handlePriceUpdate(tickerSymbol, lastPrice, symbol, now) {
    try {
      // 只有在使用本地方法时才会调用此方法
      // 保存最后收到的价格数据
      this.lastPriceData = {
        symbol: tickerSymbol,
        price: lastPrice,
        time: now || new Date()
      };
      
      // 条件性记录价格更新
      const shouldLogPrice = Math.random() < 0.1; // 只记录10%的价格更新
      if (shouldLogPrice) {
        this.logger.log(`获取到价格更新: ${tickerSymbol} = ${lastPrice}`);
      }
      
      // 调用回调
      if (typeof this.onPriceUpdate === 'function') {
        this.onPriceUpdate(tickerSymbol, lastPrice, now || new Date());
      } else {
        this.logger.log('警告: 价格更新回调未设置');
      }
    } catch (error) {
      this.logger.log(`处理价格更新出错: ${error.message}`);
    }
  }
  
  /**
   * 关闭所有WebSocket连接
   */
  closeAllConnections() {
    this.logger.log(`===== 开始关闭所有WebSocket连接 =====`);
    
    // 关闭主WebSocket连接
    this.closeWebSocket();
    
    // 重置连接状态
    this.activeConnectionCount = 0;
    this.connectOperationInProgress = false;
    this.connectionActive = false;
    this.pendingConnection = false;
    
    // 清理所有定时器
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // 清理消息去重相关资源
    if (this.messageCleanupInterval) {
      clearInterval(this.messageCleanupInterval);
      this.messageCleanupInterval = null;
    }
    this.processedMessages.clear();
    
    // 重置WebSocket引用
    this.ws = null;
    
    // 重置订阅状态
    this.resetConnectionState();
    
    this.logger.log(`===== 所有WebSocket连接已关闭并清理完成 =====`);
  }
  
  /**
   * 检查和报告连接状态
   * 用于诊断连接问题
   */
  reportConnectionStatus() {
    this.logger.log(`WebSocket连接状态报告:`);
    this.logger.log(`- 连接ID: ${this.connectionId}`);
    this.logger.log(`- 活动连接数: ${this.activeConnectionCount}`);
    this.logger.log(`- 连接活动状态: ${this.connectionActive}`);
    this.logger.log(`- WebSocket状态: ${this.ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][this.ws.readyState] : 'NULL'}`);
    this.logger.log(`- 重连尝试次数: ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
    
    const now = Date.now();
    if (this.lastConnectTime > 0) {
      this.logger.log(`- 上次连接尝试: ${Math.floor((now - this.lastConnectTime) / 1000)} 秒前`);
    }
    if (this.lastCloseTime > 0) {
      this.logger.log(`- 上次连接关闭: ${Math.floor((now - this.lastCloseTime) / 1000)} 秒前`);
    }
    
    this.logger.log(`- 连接操作进行中: ${this.connectOperationInProgress}`);
    this.logger.log(`- 挂起的连接请求: ${this.pendingConnection}`);
  }
  
  /**
   * 设置消息记录清理定时器
   */
  setupMessageCleanup() {
    // 清理可能存在的旧定时器
    if (this.messageCleanupInterval) {
      clearInterval(this.messageCleanupInterval);
    }
    
    // 每5分钟清理一次过期的消息记录
    this.messageCleanupInterval = setInterval(() => {
      if (this.processedMessages.size > 0) {
        const now = Date.now();
        const expireTime = 10 * 60 * 1000; // 10分钟过期
        
        // 删除10分钟前的消息记录
        for (const [key, timestamp] of this.processedMessages.entries()) {
          if (now - timestamp > expireTime) {
            this.processedMessages.delete(key);
          }
        }
        
        // 如果map变得太大，移除最早的记录
        if (this.processedMessages.size > this.maxProcessedMessages) {
          const entriesToRemove = this.processedMessages.size - this.maxProcessedMessages;
          const entries = Array.from(this.processedMessages.entries())
            .sort((a, b) => a[1] - b[1])
            .slice(0, entriesToRemove);
          
          for (const [key] of entries) {
            this.processedMessages.delete(key);
          }
        }
      }
    }, 5 * 60 * 1000); // 5分钟
  }
}

module.exports = WebSocketManager; 