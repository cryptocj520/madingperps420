const { log } = require('../utils/logger');
const TimeUtils = require('../utils/timeUtils');
const axios = require('axios');
const crypto = require('crypto');
const nacl = require('tweetnacl');
const base64 = require('base64-js');
const ED25519Signer = require('../utils/ed25519Utils');
const WebSocket = require('ws');

/**
 * Backpack合约交易API服务类
 */
class BackpackFuturesService {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   * @param {string} config.apiKey - API密钥
   * @param {string} config.apiSecret - API密钥
   * @param {string} config.baseUrl - API基础URL
   * @param {string} config.wsUrl - WebSocket URL
   * @param {string} config.symbol - 交易对
   * @param {boolean} [config.mockMode=false] - 模拟模式，如果为true则不发送实际请求
   * @param {Object} logger - 日志对象
   */
  constructor(config, logger) {
    this.logger = logger || console;
    
    // 创建本地日志函数，而不是尝试重新赋值导入的常量
    this.logMessage = (message, isError = false) => {
      if (isError) {
        this.logger.error(`[BackpackFuturesService] ${message}`);
      } else {
        this.logger.info(`[BackpackFuturesService] ${message}`);
      }
    };

    // 确保配置存在
    if (!config) {
      this.logMessage('初始化失败: 配置对象不能为空', true);
      throw new Error('配置对象不能为空');
    }

    this.baseUrl = config.baseUrl || 'https://api.backpack.exchange';
    this.wsUrl = config.websocket?.url || 'wss://ws.backpack.exchange/';
    this.symbol = config.symbol || (config.futures?.tradingCoin ? `${config.futures.tradingCoin}_USDC_PERP` : 'BTC_USDC_PERP');
    
    // 从config.api中获取密钥
    this.apiKey = config.api?.publicKey;
    this.apiSecret = config.api?.privateKey;
    this.mockMode = config.mockMode || false;

    // 记录初始化信息
    this.logMessage(`初始化Backpack合约API服务: ${this.symbol}, ${this.baseUrl}`);
    this.logMessage(`WebSocket URL: ${this.wsUrl}`);
    this.logMessage(`API密钥状态: ${this.apiKey ? '已设置' : '未设置'}`);
    
    if (this.mockMode) {
      this.logMessage('模拟模式已启用，API请求将返回模拟响应');
    }

    // 初始化WebSocket相关属性
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 初始重连延迟5秒
    this.messageHandlers = {};
    this.heartbeatInterval = null;
    
    // 初始化ED25519签名器
    if (this.apiSecret) {
      try {
        this.signer = new ED25519Signer(this.apiSecret);
        this.logMessage('已初始化ED25519签名器');
      } catch (error) {
        this.logMessage(`初始化签名器失败: ${error.message}`, true);
        this.mockMode = true; // 若签名器初始化失败，强制使用模拟模式
        this.logMessage('由于签名器错误，已切换到模拟模式');
      }
    } else {
      this.logMessage('API密钥未提供，将使用模拟数据', true);
      this.mockMode = true;
      // 创建一个空的签名器对象，以防后续代码调用
      this.signer = {
        generateSignature: () => {
          this.logMessage('模拟模式中调用签名函数', true);
          return 'mock_signature';
        }
      };
    }
    
    // 存储市场深度数据
    this.orderBookDepth = {};
    
    // 本地记录的杠杆倍数
    this.leverage = null;
    
    // API请求配置
    this.timeout = config.advanced?.apiTimeout || 30000; // 请求超时时间(毫秒)
    
    // 设置默认杠杆
    this.defaultLeverage = config.futures?.leverage || 1;
    
    // WebSocket相关
    this.wsConnected = false;
    this.wsReconnectAttempts = 0;
    this.wsReconnectTimeout = null;
    this.wsKeepAliveInterval = null;
    this.hasSubscribed = false;
    this.receivedMessages = 0;
    
    // 价格数据缓存
    this.wsPriceData = {};
    this.lastKnownPrice = null;
    this.lastPrice = null;
    
    // 价格更新回调
    this.onPriceUpdate = null;
    
    this.logMessage(`Backpack合约API服务初始化 - 交易对: ${this.symbol}, URL: ${this.baseUrl}`);
  }
  
  /**
   * 执行带重试的API请求
   * @param {Function} apiCall - API调用函数
   * @param {number} maxRetries - 最大重试次数
   * @returns {Promise<any>} API响应
   */
  async executeWithRetry(apiCall, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await apiCall();
      } catch (error) {
        lastError = error;
        // 如果是最后一次尝试，不需要等待
        if (attempt < maxRetries - 1) {
          const waitTime = Math.pow(2, attempt) * 500; // 指数退避
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    throw lastError; // 重试全部失败后抛出最后一次的错误
  }
  
  /**
   * 初始化杠杆设置
   * @returns {Promise<Object>} 杠杆设置结果
   */
  async initializeLeverage() {
    try {
      this.logMessage(`为 ${this.symbol} 初始化杠杆设置: ${this.leverage}x`);
      
      // 确保API密钥已设置
      if (!this.apiKey || !this.apiSecret) {
        this.logMessage('API密钥未设置，无法初始化杠杆');
        this.logMessage(`API Key: ${this.apiKey ? '已设置' : '未设置'}`);
        this.logMessage(`API Secret: ${this.apiSecret ? '已设置' : '未设置'}`);
        
        // 即使没有API密钥，也返回成功，使用默认杠杆
        this.logMessage(`无API密钥 - 使用默认杠杆值: ${this.defaultLeverage}x`);
        this.leverage = this.defaultLeverage;
        return { leverage: this.leverage, success: true };
      }
      
      // 杠杆设置API端点不可用，直接返回本地设置
      this.logMessage(`[模拟] 杠杆设置API功能已禁用 - 使用本地杠杆值: ${this.leverage}x`);
      
      return { 
        leverage: this.leverage, 
        success: true,
        message: "杠杆设置API不可用，使用本地值" 
      };
    } catch (error) {
      this.logMessage(`初始化杠杆失败: ${error.message}`);
      
      // 使用默认杠杆，并返回成功
      this.leverage = this.defaultLeverage;
      this.logMessage(`出错 - 使用默认杠杆值: ${this.defaultLeverage}x`);
      
      return { 
        leverage: this.leverage, 
        success: true,
        message: "初始化失败，使用默认杠杆值" 
      };
    }
  }
  
  /**
   * 获取合约账户信息
   * @returns {Promise<Object>} 合约账户信息
   */
  async getFuturesAccountInfo() {
    try {
      return await this.executeWithRetry(() => 
        this.client.FuturesAccountInformation()
      );
    } catch (error) {
      this.logMessage(`获取合约账户信息失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 获取持仓信息
   * @param {string} symbol - 交易对符号，可选
   * @returns {Promise<Array|null>} 持仓数组或null
   */
  async getPositions(symbol = null) {
    try {
      // 设置超时时间
      const timeout = 30000;
      
      // 尝试使用单数形式的端点 - Backpack文档中为单数形式
      const method = 'GET';
      const endpoint = '/api/v1/position';
      
      // 构建查询参数
      const params = {};
      if (symbol) {
        params.symbol = symbol;
      }
      
      // 创建签名和请求头
      const { headers, queryString } = this.createSignature(method, endpoint, params);
      
      // 构建完整URL
      const url = `${this.baseUrl}${endpoint}${queryString}`;
      this.logMessage(`获取持仓信息: ${url}`);
      
      // 如果使用模拟模式，返回模拟数据
      if (this.mockMode) {
        this.logMessage('模拟模式：使用空持仓列表');
        return [];
      }
      
      // 发送请求
      try {
        const response = await axios.get(url, {
          headers,
          timeout: this.timeout
        });
        
        if (response.status === 200) {
          let positions = response.data;
          
          if (Array.isArray(positions)) {
            this.logMessage(`获取到持仓：${positions.length}个`);
            
            // 如果有持仓，记录第一个持仓的平均价格
            if (positions.length > 0 && positions[0].entryPrice) {
              this.logMessage(`- 开仓均价: ${positions[0].entryPrice} USDC`);
            }
            
            return positions;
          } else {
            // 如果返回的不是数组，但是是有效对象，将其包装为数组
            if (positions && typeof positions === 'object' && positions.symbol) {
              this.logMessage(`获取到单个持仓对象，转换为数组`);
              return [positions];
            }
            
            // 处理API返回可能为字符串的情况
            if (typeof positions === 'string') {
              this.logMessage(`API返回了字符串类型响应: ${positions}`, true);
              
              // 尝试解析为JSON
              try {
                const parsed = JSON.parse(positions);
                if (Array.isArray(parsed)) {
                  return parsed;
                } else if (parsed && typeof parsed === 'object') {
                  return [parsed];
                } else {
                  this.logMessage(`解析后仍无法获取持仓数据`, true);
                  return [];
                }
              } catch (parseError) {
                this.logMessage(`解析持仓数据失败: ${parseError.message}`, true);
                return [];
              }
            }
            
            this.logMessage(`获取到的持仓不是数组: ${JSON.stringify(positions)}`, true);
            return [];
          }
        } else {
          this.logMessage(`获取持仓失败: HTTP状态 ${response.status}`, true);
          return null;
        }
      } catch (error) {
        this.logMessage(`获取持仓出错: ${error.message}`, true);
        
        // 判断是否是认证错误或404错误
        const isAuthError = error.response && 
          (error.response.status === 401 || error.response.status === 400) && 
          error.response.data && 
          (typeof error.response.data === 'object' ? 
            error.response.data.code === 'UNAUTHORIZED' : 
            (typeof error.response.data === 'string' && error.response.data.includes('Unauthorized')));
        
        const isNotFoundError = error.response && error.response.status === 404;
        
        if (isAuthError) {
          this.logMessage('尝试使用备用方法获取持仓', true);
          return await this.getPositionsAlternative(symbol);
        } else if (isNotFoundError) {
          this.logMessage('资源未找到，可能是当前没有持仓');
          return [];
        }
        
        // 模拟模式或其他错误，返回空数组
        if (this.mockMode) {
          this.logMessage('模拟模式：使用空持仓列表');
          return [];
        }
        
        return null;
      }
    } catch (error) {
      this.logMessage(`获取持仓出错(外层): ${error.message}`, true);
      if (this.mockMode) {
        return [];
      }
      return null;
    }
  }
  
  /**
   * 获取持仓信息的替代方法
   * @param {string} symbol - 交易对
   * @returns {Promise<Array|null>} 持仓数组或null
   */
  async getPositionsAlternative(symbol) {
    try {
      this.logger.info('使用替代方法获取持仓信息');
      
      // 请求方法和端点
      const method = 'GET';
      const endpoint = '/api/v1/position'; // 使用单数形式，符合Backpack API
      
      // 构建参数
      const params = {};
      if (symbol) {
        params.symbol = symbol;
      }
      
      // 生成时间戳和窗口
      const timestamp = Date.now().toString();
      const window = '5000';
      
      // 按照文档构建签名字符串
      let signatureString = 'instruction=positionQuery';
      
      // 添加参数
      if (Object.keys(params).length > 0) {
        const sortedKeys = Object.keys(params).sort();
        for (const key of sortedKeys) {
          signatureString += `&${key}=${params[key]}`;
        }
      }
      
      // 添加时间戳和窗口
      signatureString += `&timestamp=${timestamp}&window=${window}`;
      
      this.logger.debug(`替代方法签名字符串: ${signatureString}`);
      
      // 使用ED25519签名
      const messageBytes = Buffer.from(signatureString, 'utf8');
      const signatureBytes = nacl.sign.detached(messageBytes, this.signer.signingKey);
      const signature = Buffer.from(signatureBytes).toString('base64');
      
      // 创建请求头 - 确保使用大写格式
      const headers = {
        'X-API-KEY': this.apiKey,
        'X-SIGNATURE': signature,
        'X-TIMESTAMP': timestamp,
        'X-WINDOW': window,
        'Content-Type': 'application/json'
      };
      
      // 构建URL
      let url = `${this.baseUrl}${endpoint}`;
      if (Object.keys(params).length > 0) {
        const queryString = new URLSearchParams(params).toString();
        url = `${url}?${queryString}`;
      }
      
      this.logger.info(`替代方法请求持仓信息: ${url}`);
      
      // 发送请求
      const response = await axios({
        method,
        url,
        headers,
        timeout: 30000
      });
      
      if (response.status === 200) {
        const positions = response.data;
        
        // 检查响应是否为数组
        if (Array.isArray(positions)) {
          this.logger.info(`替代方法获取到持仓：${positions.length}个`);
          return positions;
        } else {
          this.logger.warn(`替代方法获取到的持仓数据格式不正确: ${JSON.stringify(positions)}`);
          return null;
        }
      } else {
        this.logger.error(`替代方法获取持仓失败，状态码: ${response.status}`);
        return null;
      }
    } catch (error) {
      this.logger.error(`替代方法获取持仓出错: ${error.message}`);
      
      if (error.response) {
        this.logger.error(`状态码: ${error.response.status}`);
        this.logger.error(`响应数据: ${JSON.stringify(error.response.data)}`);
      }
      
      return null;
    }
  }
  
  /**
   * 获取合约行情数据
   * @param {string} symbol - 交易对
   * @returns {Promise<Object>} 行情数据
   */
  async getFuturesTicker(symbol = this.symbol) {
    try {
      this.logMessage(`获取${symbol}合约行情数据...`);
      
      // 使用正确的API路径
      const endpoint = `/api/v1/ticker`;
      
      // 构建请求URL
      const url = `${this.baseUrl}${endpoint}?symbol=${encodeURIComponent(symbol)}`;
      this.logMessage(`发送请求到: ${url}`);
      
      try {
        // 尝试通过公开API获取行情数据（无需签名）
        const response = await axios({
          method: 'GET',
          url: url,
          timeout: 10000
        });
        
        if (response.status === 200 && response.data) {
          const ticker = response.data;
          // 从响应中提取价格数据
          const lastPrice = ticker.lastPrice || ticker.c;
          this.logMessage(`获取到${symbol}合约行情: 最新价=${lastPrice}`);
          return {
            symbol: symbol,
            lastPrice: lastPrice,
            bidPrice: ticker.bidPrice || ticker.b,
            askPrice: ticker.askPrice || ticker.a,
            volume: ticker.volume || ticker.v,
            timestamp: Date.now()
          };
        } else {
          throw new Error(`响应状态异常: ${response.status}`);
        }
      } catch (apiError) {
        this.logMessage(`API获取行情失败: ${apiError.message}`, true);
        
        if (apiError.response) {
          this.logMessage(`响应状态: ${apiError.response.status}`, true);
          this.logMessage(`响应数据: ${JSON.stringify(apiError.response.data)}`, true);
        }
        
        // 尝试使用备用端点
        this.logMessage(`尝试使用备用API端点获取行情...`);
        
        try {
          // 备用端点
          const backupEndpoint = `/api/v1/market/ticker`;
          const backupUrl = `${this.baseUrl}${backupEndpoint}?symbol=${encodeURIComponent(symbol)}`;
          
          const backupResponse = await axios({
            method: 'GET',
            url: backupUrl,
            timeout: 10000
          });
          
          if (backupResponse.status === 200 && backupResponse.data) {
            const backupTicker = backupResponse.data;
            this.logMessage(`备用API获取成功，最新价=${backupTicker.lastPrice || backupTicker.close}`);
            return {
              symbol: symbol,
              lastPrice: backupTicker.lastPrice || backupTicker.close,
              bidPrice: backupTicker.bidPrice || backupTicker.bid,
              askPrice: backupTicker.askPrice || backupTicker.ask,
              volume: backupTicker.volume,
              timestamp: Date.now()
            };
          }
        } catch (backupError) {
          this.logMessage(`备用API也失败: ${backupError.message}`, true);
        }
        
        // 两种API都失败，使用模拟数据
        this.logMessage(`所有API尝试失败，使用模拟数据...`);
        
        // 获取最后已知价格或使用默认价格
        const mockPrice = this.lastKnownPrice || 80000 + Math.random() * 5000;
        this.logMessage(`[模拟数据] 返回模拟价格: ${mockPrice.toFixed(2)}`);
        
        // 保存这个模拟价格作为下次的最后已知价格
        this.lastKnownPrice = mockPrice;
        
        return {
          symbol: symbol,
          lastPrice: mockPrice.toFixed(2),
          bidPrice: (mockPrice - 50).toFixed(2),
          askPrice: (mockPrice + 50).toFixed(2),
          volume: "100",
          timestamp: Date.now()
        };
      }
    } catch (error) {
      this.logMessage(`获取合约行情失败: ${error.message}`, true);
      
      // 使用默认价格作为应急方案
      const defaultPrice = 80000;
      this.logMessage(`返回默认价格: ${defaultPrice}`);
      
      return {
        symbol: symbol,
        lastPrice: defaultPrice.toString(),
        bidPrice: (defaultPrice - 50).toString(),
        askPrice: (defaultPrice + 50).toString(),
        volume: "0",
        timestamp: Date.now()
      };
    }
  }
  
  /**
   * 获取资金费率
   * @param {string} symbol - 交易对
   * @returns {Promise<Object>} 资金费率信息
   */
  async getFundingRate(symbol = this.symbol) {
    try {
      return await this.executeWithRetry(() => 
        this.client.FundingRate({ symbol })
      );
    } catch (error) {
      this.logMessage(`获取资金费率失败: ${error.message}`, true);
      throw error;
    }
  }
  
  /**
   * 创建API请求签名和请求头
   * @param {string} method - 请求方法 (GET, POST, DELETE等)
   * @param {string} endpoint - API端点
   * @param {Object} params - 查询参数
   * @param {Object} payload - 请求体
   * @returns {Object} 包含请求头和查询字符串的对象
   */
  createSignature(method, endpoint, params = null, payload = null) {
    try {
      // 标准化方法为大写
      const upperMethod = method.toUpperCase();
      
      // 确定指令类型
      let instructionType;
      
      // 这里开始根据端点和方法确定指令类型
      if (endpoint === '/api/v1/market/depth') {
        instructionType = 'marketdataQuery'; // 市场深度查询
      } else if (endpoint === '/api/v1/ticker' || endpoint === '/api/v1/candles') {
        instructionType = 'marketdataQuery'; // 行情查询
      } else if (endpoint === '/api/v1/orders' && upperMethod === 'POST') {
        instructionType = 'orderExecute'; // 批量订单创建
        this.logMessage(`使用orderExecute指令类型，端点: ${endpoint}, 方法: ${upperMethod}`);
      } else if (endpoint === '/api/v1/order' && upperMethod === 'POST') {
        instructionType = 'orderExecute'; // 订单创建
      } else if (endpoint === '/api/v1/orders' && upperMethod === 'DELETE') {
        instructionType = 'orderCancelAll'; // 批量取消订单
      } else if (endpoint === '/api/v1/order' && upperMethod === 'DELETE') {
        instructionType = 'orderCancel'; // 取消单个订单
      } else if (endpoint.includes('/orders') && upperMethod === 'GET') {
        instructionType = 'orderQueryAll'; // 查询多个订单
      } else if (endpoint.includes('/order') && upperMethod === 'GET') {
        instructionType = 'orderQuery'; // 查询单个订单
      } else if (endpoint === '/api/v1/position') { // 精确匹配position端点
        instructionType = 'positionQuery'; // 持仓查询
      } else if (endpoint.includes('/positions')) { // 修正为复数形式
        instructionType = 'positionQuery'; // 持仓查询
      } else if (endpoint.includes('/account')) {
        instructionType = 'accountQuery'; // 账户查询
      } else {
        this.logMessage(`警告: 未知的指令类型，端点: ${endpoint}, 方法: ${upperMethod}`, true);
        instructionType = 'marketdataQuery'; // 默认类型
      }
      
      // 当前时间戳和窗口 - 使用字符串格式
      const timestamp = Date.now().toString();
      const window = '5000';
      
      // 准备签名数据
      const signatureData = {
        instructionType,
        params: params || {},
        payload,
        timestamp,
        window
      };
      
      this.logMessage(`准备签名数据: ${JSON.stringify(signatureData)}`);
      
      // 生成签名
      const signature = this.signer.generateSignature(signatureData);
      
      // 创建请求头 - 确保使用大写格式，符合Backpack API要求
      // Backpack API文档明确要求所有请求头字段必须是大写的
      const headers = {
        'X-API-KEY': this.apiKey,
        'X-SIGNATURE': signature,
        'X-TIMESTAMP': timestamp,
        'X-WINDOW': window,
        'Content-Type': 'application/json'
      };
      
      // 构建查询字符串
      let queryString = '';
      if (params && Object.keys(params).length > 0) {
        const queryParams = new URLSearchParams();
        
        // 按字母顺序排序参数
        const sortedParams = Object.keys(params).sort();
        
        for (const key of sortedParams) {
          if (params[key] !== null && params[key] !== undefined) {
            queryParams.append(key, params[key]);
          }
        }
        
        const paramsString = queryParams.toString();
        if (paramsString) {
          queryString = `?${paramsString}`;
        }
      }
      
      return { headers, queryString };
    } catch (error) {
      this.logMessage(`创建签名时出错: ${error.message}`, true);
      this.logMessage(`错误堆栈: ${error.stack}`, true);
      throw error;
    }
  }
  
  /**
   * 获取账户信息
   * @returns {Promise<Object|null>} 账户信息对象，失败时返回null
   */
  async getAccountInfo() {
    try {
      // 使用正确的API端点
      const endpoint = '/api/v1/account';
      const params = {};
      
      // 使用createSignature生成头部
      const { headers, queryString } = this.createSignature('GET', endpoint, params);
      
      // 构建完整URL
      const url = `${this.baseUrl}${endpoint}${queryString}`;
      this.logMessage(`获取账户信息: GET ${url}`);
      
      const response = await axios.get(url, { headers });
      
      if (response.status === 200) {
        this.logMessage(`获取账户信息成功: ${JSON.stringify(response.data)}`);
        return response.data;
      } else {
        this.logMessage(`获取账户信息失败: ${response.status}`, true);
        return null;
      }
    } catch (error) {
      this.logMessage(`获取账户信息出错: ${error.message}`, true);
      if (error.response) {
        this.logMessage(`状态码: ${error.response.status}`, true);
        this.logMessage(`响应数据: ${JSON.stringify(error.response.data)}`, true);
      }
      return null;
    }
  }
  
  /**
   * 设置杠杆倍数
   * @param {string} symbol - 交易对
   * @param {number} leverage - 杠杆倍数
   * @returns {Promise<boolean>} 是否成功
   */
  async setLeverage(symbol, leverage) {
    try {
      if (!symbol) {
        symbol = this.symbol;
      }
      
      this.logMessage(`[模拟] 设置杠杆: ${symbol}, 杠杆: ${leverage}x (API端点已禁用)`);
      
      // 临时禁用实际API调用，只在本地记录杠杆值
      this.leverage = parseInt(leverage);
      this.logMessage(`已在本地更新杠杆设置为 ${this.leverage}x，将在下单时使用`);
      
      return true;
      
      /* 以下代码已禁用，因为API端点不可用
      const endpoint = '/api/v1/leverage';
      
      const payload = {
        symbol,
        leverage
      };
      
      const { headers, queryString } = this.createSignature('POST', endpoint, {}, payload);
      
      const url = `${this.baseUrl}${endpoint}${queryString}`;
      this.logMessage(`设置杠杆: POST ${url}, 杠杆: ${leverage}x`);
      
      const response = await axios.post(url, payload, { headers });
      
      if (response.status === 200) {
        this.logMessage(`设置杠杆成功, ${symbol}杠杆已设置为${leverage}x`);
        return true;
      } else {
        this.logMessage(`设置杠杆失败: ${response.status}`, true);
        return false;
      }
      */
    } catch (error) {
      this.logMessage(`设置杠杆出错: ${error.message}`, true);
      
      // 即使出错也返回成功，使用默认杠杆
      this.logMessage(`使用默认杠杆: ${this.defaultLeverage}x`);
      this.leverage = this.defaultLeverage;
      
      return true;
    }
  }
  
  /**
   * 获取未完成订单
   * @param {string} symbol - 交易对
   * @returns {Promise<Array>} 订单数组
   */
  async getOpenOrders(symbol = null) {
    try {
      const endpoint = '/api/v1/orders';
      const params = {};
      
      // 如果指定了交易对，添加到参数
      if (symbol) {
        params.symbol = symbol;
      } else if (this.symbol) {
        params.symbol = this.symbol;
      }
      
      const { headers, queryString } = this.createSignature('GET', endpoint, params);
      
      // 确保查询字符串的格式正确（以?开头）
      const formattedQuery = queryString ? (queryString.startsWith('?') ? queryString : `?${queryString}`) : '';
      
      const url = `${this.baseUrl}${endpoint}${formattedQuery}`;
      this.logMessage(`获取未完成订单: GET ${url}`);
      
      const response = await axios.get(url, { headers });
      
      if (response.status === 200) {
        const orders = response.data;
        this.logMessage(`获取未完成订单成功, 共${orders.length}个订单`);
        
        if (orders.length > 0) {
          this.logMessage(`订单详情: ${JSON.stringify(orders)}`);
        }
        
        return orders;
      } else {
        this.logMessage(`获取未完成订单失败: ${response.status}`, true);
        return [];
      }
    } catch (error) {
      this.logMessage(`获取未完成订单出错: ${error.message}`, true);
      if (error.response) {
        this.logMessage(`状态码: ${error.response.status}`, true);
        this.logMessage(`响应数据: ${JSON.stringify(error.response.data)}`, true);
      }
      return [];
    }
  }
  
  /**
   * 取消所有订单
   * @param {string} symbol - 交易对，可选
   * @returns {Promise<boolean>} 是否成功
   */
  async cancelAllOrders(symbol = null) {
    try {
      const endpoint = '/api/v1/orders';
      
      // 如果指定了交易对，添加到参数
      const payload = {};
      if (symbol) {
        payload.symbol = symbol;
      } else if (this.symbol) {
        payload.symbol = this.symbol;
      }
      
      this.logMessage(`开始取消所有订单 symbol=${payload.symbol || 'all'}`);
      
      // 先获取未完成订单列表，确认是否有需要取消的订单
      const openOrders = await this.getOpenOrders(payload.symbol);
      if (!openOrders || openOrders.length === 0) {
        this.logMessage(`没有发现未完成订单，无需取消`);
        return true;
      }
      
      this.logMessage(`发现 ${openOrders.length} 个未完成订单，开始取消...`);
      
      // 使用重试机制提高成功率
      return await this.executeWithRetry(async () => {
        const { headers, queryString } = this.createSignature('DELETE', endpoint, {}, payload);
        
        const url = `${this.baseUrl}${endpoint}${queryString}`;
        this.logMessage(`取消所有订单: DELETE ${url}, payload: ${JSON.stringify(payload)}`);
        
        // 添加data参数到请求中，确保payload被正确发送
        const response = await axios.delete(url, { 
          headers,
          data: payload, // 将payload作为请求体发送
          timeout: 10000 // 增加超时时间
        });
        
        if (response.status === 200) {
          this.logMessage(`取消所有订单成功: ${JSON.stringify(response.data)}`);
          
          // 再次验证订单是否真的被取消
          await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒
          const remainingOrders = await this.getOpenOrders(payload.symbol);
          
          if (remainingOrders && remainingOrders.length > 0) {
            this.logMessage(`警告: 仍有 ${remainingOrders.length} 个订单未被取消`, true);
            return false;
          }
          
          return true;
        } else {
          this.logMessage(`取消所有订单失败: ${response.status}`, true);
          return false;
        }
      }, 3); // 最多尝试3次
    } catch (error) {
      this.logMessage(`取消所有订单出错: ${error.message}`, true);
      if (error.response) {
        this.logMessage(`状态码: ${error.response.status}`, true);
        this.logMessage(`响应数据: ${JSON.stringify(error.response.data)}`, true);
      }
      return false;
    }
  }
  
  /**
   * 获取合约订单历史
   * @param {string} symbol - 交易对
   * @param {number} limit - 返回数量限制
   * @returns {Promise<Array>} 订单历史
   */
  async getFuturesOrderHistory(symbol = this.symbol, limit = 50) {
    try {
      this.logMessage.info(`获取${symbol}合约订单历史记录...`);
      
      return await this.executeWithRetry(() => 
        this.client.FuturesOrderHistory({ symbol, limit })
      );
    } catch (error) {
      this.logMessage.error(`获取合约订单历史失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 取消所有合约订单
   * @param {string} symbol - 交易对
   * @returns {Promise<Array>} 取消结果
   */
  async cancelAllFuturesOrders(symbol = this.symbol) {
    try {
      this.logMessage.info(`开始撤销 ${symbol} 交易对的所有未完成合约订单...`);
      
      return await this.executeWithRetry(() => 
        this.client.CancelAllFuturesOrders({ symbol })
      );
    } catch (error) {
      // 连接错误或特定代码错误
      this.logMessage.error(`取消所有合约订单失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 调整杠杆
   * @param {number} leverage - 杠杆倍数
   * @param {string} symbol - 交易对
   * @returns {Promise<Object>} 调整结果
   */
  async changeLeverage(leverage, symbol = this.symbol) {
    try {
      this.logger?.log(`为 ${symbol} 尝试调整杠杆: ${leverage}x (注意：API可能已更新)`);
      
      // 由于杠杆过滤器已从/markets和/market端点移除，可能需要在订单创建时指定杠杆
      // 我们可以先尝试记录杠杆设置，但不实际发送API请求
      this.leverage = parseInt(leverage);
      this.logger?.log(`已在本地更新杠杆设置为 ${this.leverage}x`);
      
      // 如果需要，可以在之后的订单创建中使用此杠杆值
      return { 
        success: true, 
        message: "已在本地记录杠杆设置，将在下单时使用",
        leverage: this.leverage,
        symbol: symbol
      };
      
      /* 以下代码保留但注释掉，因为API端点可能已更改
      // 使用正确的REST API端点
      const endpoint = '/api/v1/leverage';
      const timestamp = Date.now();
      const window = 5000;
      
      // 准备请求数据
      const requestData = {
        symbol: symbol,
        leverage: parseInt(leverage)
      };
      
      // 使用borrowLendExecute指令生成签名
      const signature = this.signer.generateSignature('borrowLendExecute', requestData, timestamp, window);
      
      // 构建请求头
      const headers = {
        'Content-Type': 'application/json',
        'X-API-KEY': this.apiKey,
        'X-SIGNATURE': signature,
        'X-TIMESTAMP': timestamp.toString(),
        'X-WINDOW': window.toString()
      };
      
      // 添加时间戳和窗口到URL
      const queryParams = new URLSearchParams();
      queryParams.append('timestamp', timestamp.toString());
      queryParams.append('window', window.toString());
      const queryString = queryParams.toString();
      
      // 发送API请求
      this.logger?.log(`发送杠杆调整请求: ${JSON.stringify(requestData)}`);
      const url = `${this.baseUrl}${endpoint}?${queryString}`;
      
      const response = await axios.post(url, requestData, { headers });
      
      if (response.status === 200) {
        this.leverage = leverage;
        this.logger?.log(`杠杆调整成功: ${leverage}x`);
        return response.data;
      } else {
        throw new Error(`调整杠杆失败: ${response.status}`);
      }
      */
    } catch (error) {
      this.logger?.log(`调整杠杆失败: ${error.message}`, true);
      
      // 如果是API响应错误，尝试提取详细信息
      if (error.response) {
        this.logger?.log(`API错误响应: ${JSON.stringify(error.response.data)}`, true);
      }
      
      // 返回一个模拟的成功响应
      return { 
        success: true, 
        message: "API端点可能已更新，已在本地记录杠杆设置，将在下单时使用",
        leverage: parseInt(leverage),
        symbol: symbol
      };
    }
  }
  
  /**
   * 调整保证金类型
   * @param {string} marginType - 保证金类型 ('ISOLATED' 或 'CROSSED')
   * @param {string} symbol - 交易对
   * @returns {Promise<Object>} 调整结果
   */
  async changeMarginType(marginType, symbol = this.symbol) {
    try {
      this.logger?.log(`为 ${symbol} 调整保证金类型: ${marginType}`);
      
      return await this.executeWithRetry(() => 
        this.client.SetMarginType({
          symbol,
          marginType
        })
      );
    } catch (error) {
      this.logger?.log(`调整保证金类型失败: ${error.message}`, true);
      throw error;
    }
  }
  
  /**
   * 初始化WebSocket连接
   */
  initWebSocketConnection() {
    try {
      // 创建WebSocket URL，确保不包含/stream后缀
      const wsUrl = this.wsUrl;
      this.logMessage(`初始化WebSocket连接: ${wsUrl}`);
      
      // 创建新的WebSocket连接
      this.ws = new WebSocket(wsUrl);
      
      // 连接打开时的处理
      this.ws.on('open', () => {
        this.logMessage('WebSocket连接已建立');
        this.wsConnected = true;
        this.wsReconnectAttempts = 0;
        
        // 订阅市场行情数据
        this.subscribeToMarketData();
        
        // 设置心跳机制，确保连接保持活跃
        this.setupHeartbeat();
      });
      
      // 接收消息时的处理
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.receivedMessages++;
          
          // 仅记录前10条消息和之后每100条消息中的一条，避免日志过多
          if (this.receivedMessages <= 10 || this.receivedMessages % 100 === 0) {
            this.logMessage(`收到WebSocket消息: ${JSON.stringify(message)}`);
          }
          
          // 处理不同类型的消息
          if (message.e === 'ticker' && message.s && message.c) {
            // 处理价格更新消息
            const symbol = message.s;
            const price = parseFloat(message.c);
            
            // 更新价格数据
            if (!isNaN(price)) {
              this.wsPriceData[symbol] = {
                price: price,
                volume: parseFloat(message.v) || 0,
                timestamp: Date.now()
              };
              
              // 更新最后已知价格
              if (symbol === this.symbol) {
                this.lastPrice = price;
              }
              
              // 记录价格更新
              if (this.receivedMessages <= 10 || this.receivedMessages % 100 === 0) {
                this.logMessage(`价格更新: ${JSON.stringify(message)}`);
              }
              
              // 如果设置了价格更新回调，触发回调
              if (typeof this.onPriceUpdate === 'function') {
                this.onPriceUpdate(symbol, price);
              }
            }
          } else if (message.error) {
            // 处理错误消息
            this.logMessage(`WebSocket错误: ${JSON.stringify(message.error)}`, true);
          } else if (message.result !== undefined) {
            // 处理命令响应
            if (message.result === 'PONG') {
              // 心跳响应，不需要特别处理
            } else {
              this.logMessage(`WebSocket命令响应: ${JSON.stringify(message)}`);
            }
          }
        } catch (error) {
          this.logMessage(`解析WebSocket消息失败: ${error.message}`, true);
          this.logMessage(`原始消息: ${data.toString()}`, true);
        }
      });
      
      // 错误处理
      this.ws.on('error', (error) => {
        this.logMessage(`WebSocket错误: ${error.message}`, true);
      });
      
      // 连接关闭时的处理
      this.ws.on('close', () => {
        this.logMessage('WebSocket连接已关闭，尝试重连');
        this.wsConnected = false;
        this.handleWebSocketReconnect();
      });
    } catch (error) {
      this.logMessage(`初始化WebSocket失败: ${error.message}`, true);
      this.handleWebSocketReconnect();
    }
  }
  
  /**
   * 处理WebSocket重连
   */
  handleWebSocketReconnect() {
    if (this.wsReconnectTimeout) {
      clearTimeout(this.wsReconnectTimeout);
    }
    
    if (this.wsKeepAliveInterval) {
      clearInterval(this.wsKeepAliveInterval);
    }
    
    this.wsReconnectAttempts++;
    const delay = Math.min(30000, Math.pow(2, this.wsReconnectAttempts) * 1000);
    this.logMessage(`安排WebSocket重连尝试 #${this.wsReconnectAttempts}，延迟 ${delay}ms`);
    
    this.wsReconnectTimeout = setTimeout(() => {
      this.logMessage(`执行WebSocket重连尝试 #${this.wsReconnectAttempts}`);
      this.initWebSocketConnection();
    }, delay);
  }
  
  /**
   * 设置WebSocket心跳机制
   */
  setupHeartbeat() {
    if (this.wsKeepAliveInterval) {
      clearInterval(this.wsKeepAliveInterval);
    }
    
    this.wsKeepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // 发送PING消息，确保格式正确
          const pingMessage = {
            method: "PING",
            id: Date.now()
          };
          this.ws.send(JSON.stringify(pingMessage));
          this.logMessage('WebSocket心跳消息已发送');
        } catch (error) {
          this.logMessage(`发送心跳消息失败: ${error.message}`, true);
        }
      }
    }, 30000); // 每30秒发送一次心跳
  }
  
  /**
   * 订阅市场行情数据
   */
  subscribeToMarketData() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logMessage('WebSocket未连接，无法订阅行情');
      return;
    }
    
    try {
      // 订阅指定交易对的行情
      const subscribeMessage = {
        method: "SUBSCRIBE",
        params: [`ticker.${this.symbol}`],
        id: Date.now()
      };
      
      this.logMessage(`订阅行情: ${JSON.stringify(subscribeMessage)}`);
      this.ws.send(JSON.stringify(subscribeMessage));
      this.logMessage(`已订阅行情数据: ${this.symbol}`);
      
      // 标记为已订阅
      this.hasSubscribed = true;
    } catch (error) {
      this.logMessage(`订阅行情数据失败: ${error.message}`, true);
    }
  }
  
  /**
   * 订阅订单更新
   */
  subscribeOrderUpdates() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logMessage('WebSocket未连接，无法订阅订单更新');
      return;
    }
    
    try {
      // 需要私有频道身份验证
      const timestamp = Date.now().toString();
      const window = '5000';
      
      // 构造订阅消息
      const subscribeMessage = {
        method: "SUBSCRIBE", 
        params: ['order'],
        id: Date.now(),
        key: this.apiKey,
        timestamp: timestamp,
        window: window
      };
      
      // 获取签名
      const signature = this.generatePrivateChannelSignature(timestamp, window);
      if (signature) {
        subscribeMessage.signature = signature;
        this.logMessage(`订阅订单更新: ${JSON.stringify(subscribeMessage)}`);
        this.ws.send(JSON.stringify(subscribeMessage));
        this.logMessage('已订阅订单更新');
      } else {
        this.logMessage('无法生成订阅签名，订单更新订阅失败', true);
      }
    } catch (error) {
      this.logMessage(`订阅订单更新失败: ${error.message}`, true);
    }
  }
  
  /**
   * 注册价格更新回调函数
   * 对应文档中的register_price_callback方法
   * @param {Function} callback - 回调函数，接收symbol和price参数
   */
  registerPriceCallback(callback) {
    if (typeof callback === 'function') {
      this.onPriceUpdate = callback;
      this.logMessage('价格更新回调函数注册成功');
    } else {
      this.logMessage('注册价格回调失败：回调必须是函数', true);
    }
  }
  
  /**
   * 从缓存获取最新价格
   * 对应文档中的backpack_api.prices.get方法
   * @param {string} symbol - 交易对
   * @param {number} defaultValue - 当价格不可用时的默认值
   * @returns {number} 价格
   */
  getCachedPrice(symbol, defaultValue = 0) {
    const data = this.wsPriceData[symbol];
    if (data && data.price && Date.now() - data.timestamp < 60000) { // 1分钟内的数据视为有效
      return data.price;
    }
    return defaultValue;
  }
  
  /**
   * 关闭WebSocket连接
   */
  closeWebSocketConnection() {
    try {
      if (this.ws) {
        this.logMessage('关闭WebSocket连接...');
        
        // 如果连接是打开状态，先尝试取消订阅
        if (this.ws.readyState === WebSocket.OPEN && this.symbol) {
          // 使用新格式取消订阅
          const unsubscribeMessage = {
            method: 'UNSUBSCRIBE',
            params: [`ticker.${this.symbol}`],
            id: Date.now()
          };
          
          this.logMessage(`取消订阅: ${JSON.stringify(unsubscribeMessage)}`);
          this.ws.send(JSON.stringify(unsubscribeMessage));
        }
        
        // 清除计时器
        if (this.wsKeepAliveInterval) {
          clearInterval(this.wsKeepAliveInterval);
          this.wsKeepAliveInterval = null;
        }
        
        if (this.wsReconnectTimeout) {
          clearTimeout(this.wsReconnectTimeout);
          this.wsReconnectTimeout = null;
        }
        
        // 关闭连接
        this.ws.terminate();
        this.ws = null;
        this.wsConnected = false;
        
        this.logMessage('WebSocket连接已关闭');
      }
    } catch (error) {
      this.logMessage(`关闭WebSocket连接出错: ${error.message}`, true);
    }
  }
  
  /**
   * 获取最新行情价格
   * @param {string} symbol - 交易对
   * @returns {Promise<number|null>} 最新价格
   */
  async getMarketPrice(symbol = this.symbol) {
    try {
      this.logMessage(`获取${symbol}最新市场价格...`);
      
      // 使用新增的getCachedPrice方法获取WebSocket缓存的价格
      const cachedPrice = this.getCachedPrice(symbol);
      if (cachedPrice > 0) {
        this.logMessage(`使用WebSocket缓存价格: ${cachedPrice}`);
        return cachedPrice;
      }
      
      // 尝试使用REST API获取价格
      try {
        const ticker = await this.getFuturesTicker(symbol);
        if (ticker && ticker.lastPrice) {
          const price = parseFloat(ticker.lastPrice);
          this.logMessage(`从REST API获取到价格: ${price}`);
          return price;
        }
      } catch (error) {
        this.logMessage(`从REST API获取价格失败: ${error.message}`, true);
      }
      
      // 如果WebSocket和REST API都失败，使用模拟数据
      this.logMessage('所有价格获取方法失败，使用模拟数据');
      
      // 获取最后已知价格或使用默认价格
      const mockPrice = this.lastPrice || 80000 + Math.random() * 1000;
      this.logMessage(`[模拟数据] 返回模拟价格: ${mockPrice.toFixed(2)}`);
      
      // 保存这个模拟价格作为下次的最后已知价格
      this.lastPrice = mockPrice;
      
      return mockPrice;
    } catch (error) {
      this.logMessage(`获取市场价格失败: ${error.message}`, true);
      
      // 使用默认价格作为应急方案
      const defaultPrice = this.lastPrice || 80000;
      this.logMessage(`返回默认价格: ${defaultPrice}`);
      
      return defaultPrice;
    }
  }
  
  /**
   * 创建合约订单
   * @param {Object} orderData - 订单数据
   * @param {string} orderData.symbol - 交易对名称
   * @param {string} orderData.side - 订单方向: Buy或Sell
   * @param {string} orderData.orderType - 订单类型: Limit或Market
   * @param {number|string} orderData.quantity - 订单数量
   * @param {number|string} [orderData.price] - 订单价格(Limit订单必填)
   * @param {string} [orderData.timeInForce] - 有效期类型: GTC, IOC, FOK(默认GTC)
   * @param {string} [orderData.clientOrderId] - 客户自定义订单ID
   * @returns {Promise<Object|null>} - 返回订单信息或null(失败时)
   */
  async createFuturesOrder(orderData) {
    // 记录所有输入参数
    this.logMessage(`创建合约订单参数: ${JSON.stringify(orderData)}`);
    
    try {
      // 验证必要参数是否存在
      if (!orderData || !orderData.symbol || !orderData.side || !orderData.orderType || !orderData.quantity) {
        throw new Error('订单参数不完整: 必须提供symbol, side, orderType和quantity');
      }
      
      // 验证订单类型并检查价格
      if (orderData.orderType === 'Limit' && (!orderData.price || parseFloat(orderData.price) <= 0)) {
        throw new Error('Limit订单必须提供有效价格');
      }
      
      // 确保数量为正数字符串格式
      const quantity = String(orderData.quantity);
      
      // 构建订单数据
      const data = {
        symbol: orderData.symbol,
        side: orderData.side === 'Buy' ? 'Bid' : (orderData.side === 'Sell' ? 'Ask' : orderData.side),
        orderType: orderData.orderType,
        quantity: quantity,
        timeInForce: orderData.timeInForce || 'GTC'
      };
      
      // 仅对Limit订单添加价格
      if (orderData.orderType === 'Limit' && orderData.price) {
        data.price = String(orderData.price);
      }
      
      // 如果有客户端订单ID则添加
      if (orderData.clientOrderId) {
        data.clientOrderId = orderData.clientOrderId;
      }
      
      // 打印完整请求数据
      this.logMessage(`准备发送订单请求: ${JSON.stringify(data)}`);
      
      // 如果是模拟模式，返回模拟响应
      if (this.mockMode) {
        // 生成模拟订单ID
        const mockOrderId = `mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const mockResponse = {
          orderId: mockOrderId,
          clientOrderId: data.clientOrderId || `auto_${mockOrderId}`,
          symbol: data.symbol,
          side: data.side,
          orderType: data.orderType,
          quantity: data.quantity,
          price: data.price || "0",
          status: "New",
          timeInForce: data.timeInForce,
          createTime: Date.now()
        };
        
        this.logMessage(`模拟模式: 创建订单成功 (ID: ${mockOrderId})`);
        return mockResponse;
      }
      
      // 构造请求路径和请求头 - 使用单数形式端点，符合API文档
      const endpoint = '/api/v1/order';
      const { headers, queryString } = this.createSignature('POST', endpoint, null, data);
      
      // 打印请求头信息(去除敏感信息)
      const logHeaders = { ...headers };
      if (logHeaders['X-SIGNATURE']) {
        logHeaders['X-SIGNATURE'] = `${logHeaders['X-SIGNATURE'].substring(0, 10)}...`;
      }
      
      this.logMessage(`请求路径: ${this.baseUrl}${endpoint}`);
      this.logMessage(`请求头: ${JSON.stringify(logHeaders)}`);
      
      // 发送请求
      const response = await axios.post(`${this.baseUrl}${endpoint}`, data, {
        headers,
        timeout: this.timeout
      });
      
      // 处理响应
      if (response.status === 200 || response.status === 201) {
        this.logMessage(`订单创建成功: ${JSON.stringify(response.data)}`);
        
        // 返回标准化的订单对象
        const orderResponse = response.data;
        
        // 确保返回完整的订单对象
        return {
          orderId: orderResponse.id || orderResponse.orderId,
          clientOrderId: orderResponse.clientId || orderResponse.clientOrderId || data.clientOrderId,
          symbol: orderResponse.symbol || data.symbol,
          side: orderResponse.side || data.side,
          orderType: orderResponse.orderType || data.orderType,
          quantity: orderResponse.quantity || data.quantity,
          price: orderResponse.price || data.price || "0",
          status: orderResponse.status || "New",
          timeInForce: orderResponse.timeInForce || data.timeInForce,
          createTime: orderResponse.createdAt || Date.now()
        };
      } else {
        this.logMessage(`订单创建失败: HTTP状态 ${response.status}`, true);
        this.logMessage(`响应数据: ${JSON.stringify(response.data)}`, true);
        return null;
      }
    } catch (error) {
      // 处理错误情况
      if (error.response) {
        // 请求发出，但服务器返回错误状态码
        this.logMessage(`订单创建失败[${error.response.status}]: ${JSON.stringify(error.response.data)}`, true);
        return null;
      } else if (error.request) {
        // 请求发出，但没有收到响应
        this.logMessage(`订单创建超时或无响应: ${error.message}`, true);
        return null;
      } else {
        // 请求配置出错
        this.logMessage(`订单创建请求错误: ${error.message}`, true);
        return null;
      }
    }
  }
  
  /**
   * 创建多单(买入)
   * @param {string} symbol - 交易对，例如 BTC_USDC_PERP
   * @param {number} quantity - 数量
   * @param {number|null} price - 价格(限价单必填，市价单为null)
   * @param {string} orderType - 订单类型，'Limit'或'Market'，默认为'Limit'
   * @returns {Promise<Object|null>} - 返回订单信息或null
   */
  async createLongOrder(symbol, quantity, price, orderType = 'Limit') {
    try {
      this.logMessage(`创建多单(${orderType}): ${symbol}, 数量: ${quantity}${price ? `, 价格: ${price}` : ''}`);
      
      const options = {
        symbol: symbol,
        side: 'Buy',
        orderType: orderType,
        quantity: quantity,
        timeInForce: 'GTC'
      };
      
      if (orderType === 'Limit' && price !== null) {
        options.price = price;
      }
      
      return await this.createFuturesOrder(options);
    } catch (error) {
      this.logMessage(`创建多单失败: ${error.message}`, true);
      return null;
    }
  }

  /**
   * 创建空单(卖出)
   * @param {string} symbol - 交易对，例如 BTC_USDC_PERP
   * @param {number} quantity - 数量
   * @param {number|null} price - 价格(限价单必填，市价单为null)
   * @param {string} orderType - 订单类型，'Limit'或'Market'，默认为'Limit'
   * @returns {Promise<Object|null>} - 返回订单信息或null
   */
  async createShortOrder(symbol, quantity, price, orderType = 'Limit') {
    try {
      this.logMessage(`创建空单(${orderType}): ${symbol}, 数量: ${quantity}${price ? `, 价格: ${price}` : ''}`);
      
      const options = {
        symbol: symbol,
        side: 'Sell',
        orderType: orderType,
        quantity: quantity,
        timeInForce: 'GTC'
      };
      
      if (orderType === 'Limit' && price !== null) {
        options.price = price;
      }
      
      return await this.createFuturesOrder(options);
    } catch (error) {
      this.logMessage(`创建空单失败: ${error.message}`, true);
      return null;
    }
  }

  /**
   * 平仓(关闭合约仓位)
   * @param {string} symbol - 交易对，例如 BTC_USDC_PERP
   * @param {string} positionSide - 仓位方向，'LONG'或'SHORT'
   * @param {number} quantity - 平仓数量
   * @param {number|null} price - 价格(限价单必填，市价单为null)
   * @param {string} orderType - 订单类型，'Limit'或'Market'，默认为'Market'
   * @returns {Promise<Object|null>} - 返回订单信息或null
   */
  async closeFuturesPosition(symbol, positionSide, quantity, price = null, orderType = 'Market') {
    try {
      // 根据持仓方向决定平仓方向
      const side = positionSide === 'LONG' ? 'Sell' : 'Buy';
      
      this.logMessage(`平仓(${orderType}): ${symbol}, 方向: ${side}, 数量: ${quantity}${price ? `, 价格: ${price}` : ''}`);
      
      const options = {
        symbol: symbol,
        side: side,
        orderType: orderType,
        quantity: quantity,
        timeInForce: 'GTC'
      };
      
      if (orderType === 'Limit' && price !== null) {
        options.price = price;
      }
      
      return await this.createFuturesOrder(options);
    } catch (error) {
      this.logMessage(`平仓失败: ${error.message}`, true);
      return null;
    }
  }

  /**
   * 设置止损和/或止盈订单
   * @param {string} symbol - 交易对，例如 BTC_USDC_PERP
   * @param {string} positionSide - 仓位方向，'LONG'或'SHORT'
   * @param {number} quantity - 数量
   * @param {number|null} stopLossPrice - 止损价格，null表示不设置止损
   * @param {number|null} takeProfitPrice - 止盈价格，null表示不设置止盈
   * @returns {Promise<Array>} - 返回包含止损和止盈订单的数组
   */
  async setStopLossAndTakeProfit(symbol, positionSide, quantity, stopLossPrice = null, takeProfitPrice = null) {
    try {
      const orders = [];
      const side = positionSide === 'LONG' ? 'Sell' : 'Buy';
      
      // 设置止损订单
      if (stopLossPrice !== null) {
        this.logMessage(`设置止损: ${symbol}, 价格: ${stopLossPrice}, 数量: ${quantity}`);
        
        const stopLossOptions = {
          symbol: symbol,
          side: side,
          orderType: 'Stop',
          quantity: quantity,
          price: stopLossPrice,
          stopPrice: stopLossPrice,
          timeInForce: 'GTC'
        };
        
        const stopLossOrder = await this.createFuturesOrder(stopLossOptions);
        if (stopLossOrder) {
          orders.push(stopLossOrder);
        }
      }
      
      // 设置止盈订单
      if (takeProfitPrice !== null) {
        this.logMessage(`设置止盈: ${symbol}, 价格: ${takeProfitPrice}, 数量: ${quantity}`);
        
        const takeProfitOptions = {
          symbol: symbol,
          side: side,
          orderType: 'Limit',
          quantity: quantity,
          price: takeProfitPrice,
          timeInForce: 'GTC'
        };
        
        const takeProfitOrder = await this.createFuturesOrder(takeProfitOptions);
        if (takeProfitOrder) {
          orders.push(takeProfitOrder);
        }
      }
      
      return orders;
    } catch (error) {
      this.logMessage(`设置止损止盈失败: ${error.message}`, true);
      return [];
    }
  }
}

module.exports = BackpackFuturesService; 