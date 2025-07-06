#!/usr/bin/env tsx

import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import multer from 'multer';
import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GRC20Service } from './services/GRC20Service';

dotenv.config();

// Configuration - Updated based on Walrus docs
const PORT = process.env.PORT || 3000;
const WALRUS_DAEMON_PORT = process.env.WALRUS_DAEMON_PORT || 31417;
const WALRUS_BINARY_PATH = process.env.WALRUS_BINARY_PATH || 'walrus';
const PUBLISHER_WALLETS_DIR = process.env.PUBLISHER_WALLETS_DIR || '~/.config/walrus/publisher-wallets';
const N_CLIENTS = process.env.WALRUS_N_CLIENTS || '4'; // Number of sub-wallets

// AI and Knowledge Graph
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Interfaces
interface WalrusStoreResponse {
  newlyCreated?: {
    blobObject: {
      id: string;
      blobId: string;
      size: number;
      encodingType: string;
      certifiedEpoch: number;
      storage: {
        startEpoch: number;
        endEpoch: number;
        storageSize: number;
      };
      deletable: boolean;
    };
    cost: number;
  };
  alreadyCertified?: {
    blobId: string;
    endEpoch: number;
    event: {
      txDigest: string;
    };
  };
}

interface InvestigationData {
  title: string;
  content: string;
  tags: string[];
  evidence: string[];
  files: any[];
  author: {
    wallet: string;
    userId: string;
  };
  bridgeTransaction: any;
  metadata: {
    createdAt: string;
    version: string;
    protocol: string;
    contentType: string;
  };
}

interface ExtractedEntities {
  investigationType: 'Financial' | 'Social' | 'Technical' | 'Legal' | 'Environmental' | 'Corporate' | 'Political';
  severityLevel: 'Low' | 'Medium' | 'High' | 'Critical';
  geographicScope: 'Local' | 'Regional' | 'National' | 'International';
  involvedEntities: {
    people: string[];
    organizations: string[];
    locations: string[];
    platforms: string[];
    walletAddresses: string[];
    websites: string[];
  };
  timeframe: {
    startDate?: string;
    endDate?: string;
    duration?: string;
  };
  financialImpact?: {
    amount?: string;
    currency?: string;
    affectedUsers?: number;
  };
  content: string;
}

// AI Entity Extractor Class
class AIEntityExtractor {
  private model;

  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  async extractEntities(content: string): Promise<ExtractedEntities> {
    const prompt = `
Analyze this investigation content and extract structured entities. Return ONLY a valid JSON object with these fields:

- investigationType: categorize as one of: "Financial", "Social", "Technical", "Legal", "Environmental", "Corporate", "Political"
- severityLevel: assess impact as: "Low", "Medium", "High", "Critical"
- geographicScope: determine scope as: "Local", "Regional", "National", "International"
- involvedEntities: {
    people: array of person names mentioned,
    organizations: array of companies/organizations,
    locations: array of geographic locations,
    platforms: array of websites/platforms/services,
    walletAddresses: array of crypto addresses,
    websites: array of URLs mentioned
  }
- timeframe: {
    startDate: if specific start date mentioned (YYYY-MM-DD format),
    endDate: if specific end date mentioned (YYYY-MM-DD format),
    duration: if duration mentioned (e.g., "3 months", "2 years")
  }
- financialImpact: {
    amount: monetary amount if mentioned,
    currency: currency type (USD, EUR, ETH, BTC, etc.),
    affectedUsers: number of affected users/victims
  }
- content: the original text

Text to analyze: "${content}"

Return only the JSON object:`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text().trim();
      
      const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const entities = JSON.parse(cleanText);
      
      // Validate and set defaults
      return {
        investigationType: entities.investigationType || 'Technical',
        severityLevel: entities.severityLevel || 'Medium',
        geographicScope: entities.geographicScope || 'Regional',
        involvedEntities: {
          people: Array.isArray(entities.involvedEntities?.people) ? entities.involvedEntities.people : [],
          organizations: Array.isArray(entities.involvedEntities?.organizations) ? entities.involvedEntities.organizations : [],
          locations: Array.isArray(entities.involvedEntities?.locations) ? entities.involvedEntities.locations : [],
          platforms: Array.isArray(entities.involvedEntities?.platforms) ? entities.involvedEntities.platforms : [],
          walletAddresses: Array.isArray(entities.involvedEntities?.walletAddresses) ? entities.involvedEntities.walletAddresses : [],
          websites: Array.isArray(entities.involvedEntities?.websites) ? entities.involvedEntities.websites : [],
        },
        timeframe: {
          startDate: entities.timeframe?.startDate,
          endDate: entities.timeframe?.endDate,
          duration: entities.timeframe?.duration,
        },
        financialImpact: entities.financialImpact ? {
          amount: entities.financialImpact.amount,
          currency: entities.financialImpact.currency,
          affectedUsers: entities.financialImpact.affectedUsers,
        } : undefined,
        content: content
      };
    } catch (error) {
      console.error('AI Entity extraction failed:', error);
      
      // Fallback: basic extraction
      return this.fallbackExtraction(content);
    }
  }

  private fallbackExtraction(content: string): ExtractedEntities {
    // Basic patterns for fallback
    const walletRegex = /0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59}/g;
    const urlRegex = /https?:\/\/[^\s]+/g;
    
    const walletAddresses = content.match(walletRegex) || [];
    const websites = content.match(urlRegex) || [];
    
    // Determine investigation type based on keywords
    const lowerContent = content.toLowerCase();
    let investigationType: ExtractedEntities['investigationType'] = 'Technical';
    
    if (lowerContent.includes('scam') || lowerContent.includes('fraud') || lowerContent.includes('money')) {
      investigationType = 'Financial';
    } else if (lowerContent.includes('fake') || lowerContent.includes('bot') || lowerContent.includes('social')) {
      investigationType = 'Social';
    } else if (lowerContent.includes('hack') || lowerContent.includes('vulnerability') || lowerContent.includes('exploit')) {
      investigationType = 'Technical';
    } else if (lowerContent.includes('legal') || lowerContent.includes('compliance') || lowerContent.includes('regulation')) {
      investigationType = 'Legal';
    } else if (lowerContent.includes('environment') || lowerContent.includes('pollution') || lowerContent.includes('climate')) {
      investigationType = 'Environmental';
    } else if (lowerContent.includes('corporate') || lowerContent.includes('company') || lowerContent.includes('insider')) {
      investigationType = 'Corporate';
    } else if (lowerContent.includes('political') || lowerContent.includes('election') || lowerContent.includes('government')) {
      investigationType = 'Political';
    }

    return {
      investigationType,
      severityLevel: 'Medium',
      geographicScope: 'Regional',
      involvedEntities: {
        people: [],
        organizations: [],
        locations: [],
        platforms: [],
        walletAddresses,
        websites,
      },
      timeframe: {},
      financialImpact: undefined,
      content
    };
  }
}

// Fixed Walrus Storage Service based on official docs
class WalrusStorageService {
  private daemonUrl: string;
  private daemonProcess?: ChildProcess;
  private healthChecked: boolean = false;

  constructor() {
    // Use combined daemon on single port as recommended by docs
    this.daemonUrl = `http://127.0.0.1:${WALRUS_DAEMON_PORT}`;
  }

  async startWalrusNodes(): Promise<void> {
    console.log('🚀 Starting Walrus daemon...');

    // Ensure publisher wallets directory exists
    const walletsDirExpanded = PUBLISHER_WALLETS_DIR.replace('~', process.env.HOME || '');
    if (!fs.existsSync(walletsDirExpanded)) {
      fs.mkdirSync(walletsDirExpanded, { recursive: true });
      console.log(`📁 Created wallets directory: ${walletsDirExpanded}`);
    }

    // Start combined daemon as recommended by Walrus docs
    console.log(`🔗 Starting Walrus daemon (aggregator + publisher) on port ${WALRUS_DAEMON_PORT}...`);
    
    this.daemonProcess = spawn(WALRUS_BINARY_PATH, [
      'daemon',
      '--bind-address', `127.0.0.1:${WALRUS_DAEMON_PORT}`,
      '--sub-wallets-dir', walletsDirExpanded,
      '--n-clients', N_CLIENTS,
    ], { 
      stdio: 'inherit',
      env: { ...process.env }
    });

    // Enhanced error handling
    this.daemonProcess.on('error', (error) => {
      console.error('❌ Walrus daemon error:', error.message);
      if (error.message.includes('ENOENT')) {
        console.error('💡 Make sure the Walrus binary is installed and in your PATH');
        console.error('💡 Download from: https://storage.googleapis.com/mysten-walrus-binaries/');
      }
    });

    this.daemonProcess.on('exit', (code, signal) => {
      console.log(`🔴 Walrus daemon exited with code ${code} (signal: ${signal})`);
      if (code !== 0) {
        console.error('❌ Daemon crashed. Check your Sui wallet configuration and SUI/WAL balance');
      }
    });

    // Wait for daemon to initialize with proper health checks
    console.log('⏳ Waiting for Walrus daemon to initialize...');
    await this.waitForDaemonReady();
    
    console.log('✅ Walrus daemon is ready and healthy');
  }

  private async waitForDaemonReady(maxAttempts: number = 30): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`🔍 Health check attempt ${attempt}/${maxAttempts}...`);
      
      if (await this.checkHealth()) {
        this.healthChecked = true;
        return;
      }
      
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between attempts
      }
    }
    
    throw new Error('Walrus daemon failed to become ready within timeout period');
  }

  async storeBlob(data: any, epochs: number = 5): Promise<{ success: boolean; blobId?: string; suiObjectId?: string; size?: number; epochs?: number; error?: string }> {
    try {
      if (!this.healthChecked) {
        console.log('⚠️ Daemon health not verified, checking now...');
        if (!(await this.checkHealth())) {
          throw new Error('Walrus daemon is not healthy');
        }
      }

      const blob = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2));

      console.log(`📦 Storing blob of size ${blob.length} bytes for ${epochs} epochs...`);

      const response = await axios.put(`${this.daemonUrl}/v1/blobs?epochs=${epochs}`, blob, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 120000, // Increased timeout for large files
      });

      const storeResult: WalrusStoreResponse = response.data;
      
      if (storeResult.newlyCreated) {
        const blobObject = storeResult.newlyCreated.blobObject;
        console.log(`✅ Blob stored successfully: ${blobObject.blobId}`);
        
        return {
          success: true,
          blobId: blobObject.blobId,
          suiObjectId: blobObject.id,
          size: blobObject.size,
          epochs: blobObject.storage.endEpoch - blobObject.storage.startEpoch
        };
      } else if (storeResult.alreadyCertified) {
        console.log(`✅ Blob already exists: ${storeResult.alreadyCertified.blobId}`);
        
        return {
          success: true,
          blobId: storeResult.alreadyCertified.blobId,
          suiObjectId: storeResult.alreadyCertified.event.txDigest,
          size: blob.length,
          epochs: epochs
        };
      } else {
        throw new Error('Unexpected response format from Walrus');
      }

    } catch (error: any) {
      console.error('❌ Error storing blob on Walrus:', error.message);
      
      // Enhanced error messaging
      let errorMessage = error.response?.data?.message || error.message;
      if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Walrus daemon is not running or not accessible';
      } else if (error.response?.status === 500) {
        errorMessage = 'Walrus daemon internal error - check SUI/WAL balance and wallet configuration';
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async retrieveBlob(blobId: string): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      console.log(`📥 Retrieving blob: ${blobId}`);

      const response = await axios.get(`${this.daemonUrl}/v1/blobs/${blobId}`, {
        timeout: 60000,
      });

      let data;
      try {
        data = JSON.parse(response.data);
      } catch {
        data = response.data;
      }

      console.log(`✅ Blob retrieved successfully: ${blobId}`);
      
      return {
        success: true,
        data: data
      };

    } catch (error: any) {
      console.error('❌ Error retrieving blob from Walrus:', error.message);
      
      let errorMessage = error.response?.data?.message || error.message;
      if (error.response?.status === 404) {
        errorMessage = 'Blob not found on Walrus network';
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      // Check daemon API endpoint as per docs
      const response = await axios.get(`${this.daemonUrl}/v1/api`, { 
        timeout: 10000,
        // Add specific headers if needed
        headers: {
          'User-Agent': 'TruETH-Walrus-Client/1.0'
        }
      });
      
      const isHealthy = response.status === 200;
      if (isHealthy) {
        console.log('✅ Walrus daemon health check passed');
      } else {
        console.warn(`⚠️ Walrus daemon health check returned status: ${response.status}`);
      }
      
      return isHealthy;
    } catch (error: any) {
      console.warn(`⚠️ Walrus daemon health check failed: ${error.message}`);
      return false;
    }
  }

  async stop(): Promise<void> {
    console.log('🛑 Stopping Walrus daemon...');

    if (this.daemonProcess) {
      console.log('🔄 Sending SIGTERM to Walrus daemon...');
      this.daemonProcess.kill('SIGTERM');
      
      const timeout = setTimeout(() => {
        console.log('⚠️ Force killing Walrus daemon...');
        this.daemonProcess?.kill('SIGKILL');
      }, 10000); // Increased timeout for graceful shutdown

      this.daemonProcess.on('exit', () => {
        clearTimeout(timeout);
        console.log('✅ Walrus daemon stopped gracefully');
      });
    }
  }

  // Utility method to get daemon status
  async getStatus(): Promise<{ isRunning: boolean; url: string; lastHealthCheck?: boolean }> {
    return {
      isRunning: !!this.daemonProcess,
      url: this.daemonUrl,
      lastHealthCheck: this.healthChecked
    };
  }
}

// Main TruETH Server Class
class TruETHServer {
  private app: Application;
  private walrusService: WalrusStorageService;
  private storage: Map<string, any> = new Map();
  private aiExtractor: AIEntityExtractor;
  private grc20Service: GRC20Service;

  constructor() {
    this.app = express();
    this.walrusService = new WalrusStorageService();
    this.aiExtractor = new AIEntityExtractor();
    this.grc20Service = new GRC20Service('TESTNET');
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(helmet({
      crossOriginEmbedderPolicy: false,
    }));
    
    this.app.use(cors({
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    }));

    this.app.use(compression());

    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: {
        success: false,
        error: 'Too many requests from this IP',
      },
    });
    this.app.use(limiter);

    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));

    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 50 * 1024 * 1024,
      },
    });
    this.app.use(upload.any());
  }

  private setupRoutes(): void {
    // Health check with enhanced Walrus status
    this.app.get('/health', this.healthCheck.bind(this));

    // Walrus daemon status endpoint
    this.app.get('/api/walrus/status', this.walrusStatus.bind(this));

    // GRC-20 space initialization
    this.app.post('/api/grc20/initialize-space', this.initializeGRC20Space.bind(this));

    // AI entity extraction preview endpoint
    this.app.post('/api/ai/extract-entities', this.extractEntitiesPreview.bind(this));
    
    // Enhanced investigation storage with GRC-20
    this.app.post('/api/investigations/store', this.storeInvestigationWithGRC20.bind(this));
    this.app.get('/api/investigations/retrieve/:blobId', this.retrieveInvestigation.bind(this));
    
    // Voting endpoints
    this.app.post('/api/investigations/:id/vote', this.recordVote.bind(this));
    this.app.get('/api/investigations/:id/votes', this.getVotes.bind(this));
    
    // Query endpoints
    this.app.get('/api/investigations/query', this.queryInvestigations.bind(this));

    // NEW: Hypergraph Direct Query Endpoints
    this.app.get('/api/hypergraph/investigations', async (req: Request, res: Response) => {
      try {
        console.log('🌐 Direct Hypergraph query requested')
        
        const filters = {
          investigationType: req.query.investigationType as string,
          severityLevel: req.query.severityLevel as string,
          status: req.query.status as string,
          geographicScope: req.query.geographicScope as string,
          authorWallet: req.query.authorWallet as string,
        }

        const cleanFilters = Object.fromEntries(
          Object.entries(filters).filter(([_, value]) => value !== undefined)
        )

        const result = await this.grc20Service.queryHypergraphDirectly(cleanFilters)

        if (result.success) {
          res.json({
            success: true,
            data: {
              investigations: result.investigations,
              count: result.investigations?.length || 0,
              filters: cleanFilters,
              source: 'hypergraph-direct'
            },
            message: `Found ${result.investigations?.length || 0} investigations via Hypergraph`
          })
        } else {
          res.status(500).json({
            success: false,
            error: result.error,
            source: 'hypergraph-direct'
          })
        }

      } catch (error: any) {
        console.error('❌ Error in Hypergraph direct query:', error)
        res.status(500).json({
          success: false,
          error: error.message,
          source: 'hypergraph-direct'
        })
      }
    })

    this.app.get('/api/hypergraph/space/:spaceId/investigations', async (req: Request, res: Response) => {
      try {
        const { spaceId } = req.params
        console.log(`🌐 Direct Hypergraph query for space: ${spaceId}`)
        
        const filters = {
          investigationType: req.query.investigationType as string,
          severityLevel: req.query.severityLevel as string,
          status: req.query.status as string,
          geographicScope: req.query.geographicScope as string,
          authorWallet: req.query.authorWallet as string,
        }

        const cleanFilters = Object.fromEntries(
          Object.entries(filters).filter(([_, value]) => value !== undefined)
        )

        // Temporarily set the space ID
        const originalSpaceId = this.grc20Service.getSpaceId()
        ;(this.grc20Service as any).spaceId = spaceId

        const result = await this.grc20Service.queryHypergraphDirectly(cleanFilters)

        // Restore original space ID
        ;(this.grc20Service as any).spaceId = originalSpaceId

        if (result.success) {
          res.json({
            success: true,
            data: {
              investigations: result.investigations,
              count: result.investigations?.length || 0,
              filters: cleanFilters,
              spaceId: spaceId,
              source: 'hypergraph-direct'
            },
            message: `Found ${result.investigations?.length || 0} investigations in space ${spaceId}`
          })
        } else {
          res.status(500).json({
            success: false,
            error: result.error,
            spaceId: spaceId,
            source: 'hypergraph-direct'
          })
        }

      } catch (error: any) {
        console.error('❌ Error in Hypergraph space query:', error)
        res.status(500).json({
          success: false,
          error: error.message,
          source: 'hypergraph-direct'
        })
      }
    })

    this.app.get('/api/hypergraph/raw/:spaceId', async (req: Request, res: Response) => {
      try {
        const { spaceId } = req.params
        console.log(`🔍 Raw Hypergraph API call for space: ${spaceId}`)
        
        const apiOrigin = 'https://hypergraph-v2-testnet.up.railway.app'
        
        // Try different API endpoints
        const endpoints = [
          `/space/${spaceId}/entities`,
          `/space/${spaceId}`,
          `/graphql`
        ]

        for (const endpoint of endpoints) {
          try {
            console.log(`🔗 Trying: ${apiOrigin}${endpoint}`)
            
            let response
            if (endpoint === '/graphql') {
              // GraphQL query
              response = await fetch(`${apiOrigin}${endpoint}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  query: `
                    query GetSpace($spaceId: ID!) {
                      space(id: $spaceId) {
                        id
                        name
                        entities {
                          id
                          name
                          description
                          types
                          values {
                            property
                            value
                          }
                        }
                      }
                    }
                  `,
                  variables: { spaceId }
                })
              })
            } else {
              // REST endpoints
              response = await fetch(`${apiOrigin}${endpoint}`, {
                method: 'GET',
                headers: {
                  'Accept': 'application/json',
                }
              })
            }

            console.log(`📡 Response status: ${response.status}`)
            
            if (response.ok) {
              const data = await response.json()
              res.json({
                success: true,
                endpoint: endpoint,
                data: data,
                spaceId: spaceId,
                apiOrigin: apiOrigin
              })
              return
            } else {
              const errorText = await response.text()
              console.log(`❌ Endpoint ${endpoint} failed: ${response.status} - ${errorText}`)
            }
            
          } catch (endpointError: any) {
            console.log(`❌ Endpoint ${endpoint} error: ${endpointError.message}`)
          }
        }

        res.status(404).json({
          success: false,
          error: 'All Hypergraph endpoints failed',
          spaceId: spaceId,
          triedEndpoints: endpoints,
          apiOrigin: apiOrigin
        })

      } catch (error: any) {
        console.error('❌ Error in raw Hypergraph query:', error)
        res.status(500).json({
          success: false,
          error: error.message
        })
      }
    })

    // GRC-20 Test Endpoints (existing)
    this.app.get('/api/grc20/investigation/:id', async (req: Request, res: Response) => {
      try {
        const { id } = req.params

        console.log(`🔍 Testing GRC-20 retrieval for investigation: ${id}`)

        const result = await this.grc20Service.getInvestigation(id)

        if (result.success) {
          res.json({
            success: true,
            data: result.investigation,
            message: 'Investigation retrieved successfully from GRC-20'
          })
        } else {
          res.status(404).json({
            success: false,
            error: result.error,
            message: 'Investigation not found in GRC-20'
          })
        }

      } catch (error: any) {
        console.error('❌ Error testing GRC-20 retrieval:', error)
        res.status(500).json({
          success: false,
          error: error.message
        })
      }
    })

    this.app.get('/api/grc20/blob/:blobId', async (req: Request, res: Response) => {
      try {
        const { blobId } = req.params

        console.log(`🔍 Testing GRC-20 retrieval for blob: ${blobId}`)

        const result = await this.grc20Service.getInvestigationByBlobId(blobId)

        if (result.success) {
          res.json({
            success: true,
            data: result.investigation,
            message: 'Investigation found by blob ID'
          })
        } else {
          res.status(404).json({
            success: false,
            error: result.error
          })
        }

      } catch (error: any) {
        console.error('❌ Error testing blob retrieval:', error)
        res.status(500).json({
          success: false,
          error: error.message
        })
      }
    })

    this.app.get('/api/grc20/investigations', async (req: Request, res: Response) => {
      try {
        const filters = {
          investigationType: req.query.investigationType as string,
          severityLevel: req.query.severityLevel as string,
          status: req.query.status as string,
          geographicScope: req.query.geographicScope as string,
          authorWallet: req.query.authorWallet as string,
        }

        const cleanFilters = Object.fromEntries(
          Object.entries(filters).filter(([_, value]) => value !== undefined)
        )

        console.log(`🔍 Testing GRC-20 query with filters:`, cleanFilters)

        const result = await this.grc20Service.queryInvestigations(cleanFilters)

        if (result.success) {
          res.json({
            success: true,
            data: {
              investigations: result.investigations,
              count: result.investigations?.length || 0,
              filters: cleanFilters
            },
            message: `Found ${result.investigations?.length || 0} investigations`
          })
        } else {
          res.status(500).json({
            success: false,
            error: result.error
          })
        }

      } catch (error: any) {
        console.error('❌ Error testing GRC-20 query:', error)
        res.status(500).json({
          success: false,
          error: error.message
        })
      }
    })

    this.app.get('/api/grc20/status', async (req: Request, res: Response) => {
      try {
        const spaceId = this.grc20Service.getSpaceId()
        const propertyIds = this.grc20Service.getPropertyIds()
        const typeIds = this.grc20Service.getTypeIds()

        res.json({
          success: true,
          data: {
            spaceId,
            isInitialized: !!spaceId,
            propertyIds,
            typeIds,
            apiOrigin: 'https://hypergraph-v2-testnet.up.railway.app',
            network: 'TESTNET'
          },
          message: 'GRC-20 service status'
        })

      } catch (error: any) {
        console.error('❌ Error getting GRC-20 status:', error)
        res.status(500).json({
          success: false,
          error: error.message
        })
      }
    })
    
    // Legacy Walrus proxy endpoints (updated to use daemon)
    this.app.put('/v1/blobs', this.storeBlob.bind(this));
    this.app.get('/v1/blobs/:blobId', this.getBlob.bind(this));
    this.app.get('/v1/api', this.getApiSpec.bind(this));

    // Error handling
    this.app.use((error: any, req: Request, res: Response, next: any) => {
      console.error('Server error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
      });
    });

    this.app.use('*', (req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        error: 'Endpoint not found',
      });
    });
  }

  private async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const walrusHealth = await this.walrusService.checkHealth();
      const walrusStatus = await this.walrusService.getStatus();

      res.json({
        success: true,
        data: {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          services: {
            walrusDaemon: walrusHealth ? 'running' : 'down',
            aiExtractor: 'ready',
            grc20Space: this.grc20Service.getSpaceId() ? 'initialized' : 'not_initialized',
          },
          walrus: {
            daemonUrl: walrusStatus.url,
            isProcessRunning: walrusStatus.isRunning,
            lastHealthCheck: walrusStatus.lastHealthCheck,
            healthStatus: walrusHealth ? 'healthy' : 'unhealthy'
          },
          stats: {
            totalInvestigations: this.storage.size,
          },
          grc20: {
            spaceId: this.grc20Service.getSpaceId(),
            propertyIds: this.grc20Service.getPropertyIds(),
            typeIds: this.grc20Service.getTypeIds(),
          }
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Health check failed',
        message: (error as Error).message,
      });
    }
  }

  private async walrusStatus(req: Request, res: Response): Promise<void> {
    try {
      const status = await this.walrusService.getStatus();
      const health = await this.walrusService.checkHealth();

      res.json({
        success: true,
        data: {
          ...status,
          health,
          daemonPort: WALRUS_DAEMON_PORT,
          nClients: N_CLIENTS,
          walletsDir: PUBLISHER_WALLETS_DIR,
          binaryPath: WALRUS_BINARY_PATH,
        }
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'Failed to get Walrus status',
        message: error.message,
      });
    }
  }

  private async initializeGRC20Space(req: Request, res: Response): Promise<void> {
    try {
      const { editorAddress, spaceName = 'TruETH Investigations' } = req.body;

      if (this.grc20Service.getSpaceId()) {
        res.json({
          success: true,
          message: 'GRC-20 space already exists',
          data: {
            spaceId: this.grc20Service.getSpaceId(),
            editorAddress,
            network: 'TESTNET',
            propertyIds: this.grc20Service.getPropertyIds(),
            typeIds: this.grc20Service.getTypeIds(),
            status: 'already_initialized'
          },
        });
        return;
      }

      if (!editorAddress) {
        res.status(400).json({
          success: false,
          error: 'Editor address is required',
        });
        return;
      }

      if (!editorAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
        res.status(400).json({
          success: false,
          error: 'Invalid Ethereum address format. Address must start with 0x and be 42 characters long.',
          example: '0x742d35Cc6634C0532925a3b8D4Ad3C72c6B39B6B'
        });
        return;
      }

      if (!process.env.GEO_PRIVATE_KEY && !process.env.GRC20_PRIVATE_KEY) {
        res.status(400).json({
          success: false,
          error: 'GEO_PRIVATE_KEY environment variable is required',
          instructions: 'Get your private key from https://www.geobrowser.io/export-wallet and set it as GEO_PRIVATE_KEY'
        });
        return;
      }

      console.log('🌌 Initializing GRC-20 space...');

      const spaceId = await this.grc20Service.initializeSpace({
        name: spaceName,
        description: 'Decentralized investigation verification platform',
        category: 'Investigation',
        editorAddress,
        network: 'TESTNET',
      });

      res.json({
        success: true,
        message: 'GRC-20 space initialized successfully',
        data: {
          spaceId,
          editorAddress,
          network: 'TESTNET',
          propertyIds: this.grc20Service.getPropertyIds(),
          typeIds: this.grc20Service.getTypeIds(),
          status: 'newly_initialized'
        },
      });

    } catch (error: any) {
      console.error('❌ Error initializing GRC-20 space:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to initialize GRC-20 space',
        message: error.message,
        details: error.stack ? error.stack.split('\n')[0] : 'No additional details',
        instructions: 'Make sure GEO_PRIVATE_KEY is set and has the correct format'
      });
    }
  }

  private async extractEntitiesPreview(req: Request, res: Response): Promise<void> {
    try {
      const { content } = req.body;

      if (!content || typeof content !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Content is required and must be a string',
        });
        return;
      }

      console.log(`🤖 Extracting entities from content: "${content.slice(0, 100)}..."`);

      const entities = await this.aiExtractor.extractEntities(content);

      console.log('✅ Entities extracted:', {
        investigationType: entities.investigationType,
        severityLevel: entities.severityLevel,
        involvedEntitiesCount: Object.values(entities.involvedEntities).reduce((sum, arr) => sum + arr.length, 0),
      });

      res.json({
        success: true,
        data: {
          entities,
          preview: {
            summary: `${entities.investigationType} investigation (${entities.severityLevel} severity) with ${entities.geographicScope.toLowerCase()} scope`,
            keyEntities: {
              type: entities.investigationType,
              severity: entities.severityLevel,
              scope: entities.geographicScope,
              entitiesFound: Object.values(entities.involvedEntities).reduce((sum, arr) => sum + arr.length, 0),
              hasFinancialImpact: !!entities.financialImpact,
            }
          }
        },
      });

    } catch (error: any) {
      console.error('❌ Error extracting entities:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to extract entities',
        message: error.message,
      });
    }
  }

  private async storeInvestigationWithGRC20(req: Request, res: Response): Promise<void> {
    try {
      const apiKey = req.headers['x-api-key'];
      const expectedKey = process.env.WALRUS_API_KEY || 'dev-key-123';
      
      if (process.env.NODE_ENV === 'production' && (!apiKey || apiKey !== expectedKey)) {
        res.status(401).json({
          success: false,
          error: 'Invalid API key',
        });
        return;
      }

      const investigationData: InvestigationData = req.body;

      if (!investigationData.title || !investigationData.content) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: title and content',
        });
        return;
      }

      console.log(`📝 Processing investigation: "${investigationData.title}"`);

      // Step 1: Extract entities using AI
      console.log('🤖 Extracting entities with AI...');
      const entities = await this.aiExtractor.extractEntities(investigationData.content);

      // Step 2: Store on Walrus
      console.log('💾 Storing data on Walrus...');
      const enhancedData = {
        ...investigationData,
        aiExtractedEntities: entities,
        metadata: {
          ...investigationData.metadata,
          aiProcessed: true,
          entitiesExtracted: new Date().toISOString(),
        }
      };

      const walrusResult = await this.walrusService.storeBlob(enhancedData, 10);

      if (!walrusResult.success) {
        res.status(500).json({
          success: false,
          error: 'Failed to store on Walrus',
          details: walrusResult.error,
        });
        return;
      }

      // Step 3: Store in GRC-20 space
      console.log('🌐 Storing metadata in GRC-20 space...');
      const investigationId = `inv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const grc20Entity = {
        id: investigationId,
        title: investigationData.title,
        content: investigationData.content,
        investigationType: entities.investigationType,
        severityLevel: entities.severityLevel,
        status: 'Pending' as const,
        geographicScope: entities.geographicScope,
        author: investigationData.author,
        evidence: investigationData.evidence || [],
        tags: investigationData.tags || [],
        createdAt: investigationData.metadata.createdAt,
        blobId: walrusResult.blobId,
      };

      const grc20Result = await this.grc20Service.storeInvestigation(grc20Entity);

      // Store metadata locally for quick lookup
      const metadata = {
        blobId: walrusResult.blobId,
        investigationId,
        title: investigationData.title,
        author: investigationData.author.wallet,
        createdAt: investigationData.metadata.createdAt,
        bridgeTxHash: investigationData.bridgeTransaction?.hash,
        size: walrusResult.size,
        aiEntities: entities,
        grc20EntityId: grc20Result.investigationEntityId,
        grc20Stored: grc20Result.success,
      };

      this.storage.set(walrusResult.blobId!, metadata);

      console.log(`✅ Investigation processed successfully: ${walrusResult.blobId}`);

      res.json({
        success: true,
        message: 'Investigation stored successfully with AI analysis and GRC-20 integration',
        data: {
          blobId: walrusResult.blobId,
          investigationId,
          suiObjectId: walrusResult.suiObjectId,
          size: walrusResult.size,
          epochs: walrusResult.epochs,
          aiEntities: entities,
          grc20: {
            stored: grc20Result.success,
            entityId: grc20Result.investigationEntityId,
            spaceId: this.grc20Service.getSpaceId(),
            error: grc20Result.error,
          },
          metadata: metadata,
        },
      });

    } catch (error: any) {
      console.error('❌ Error processing investigation:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to process investigation',
        message: error.message,
      });
    }
  }

  private async retrieveInvestigation(req: Request, res: Response): Promise<void> {
    try {
      const { blobId } = req.params;

      if (!blobId) {
        res.status(400).json({
          success: false,
          error: 'Blob ID is required',
        });
        return;
      }

      console.log(`📥 Retrieving investigation: ${blobId}`);

      const walrusResult = await this.walrusService.retrieveBlob(blobId);

      if (!walrusResult.success) {
        res.status(404).json({
          success: false,
          error: 'Failed to retrieve from Walrus',
          details: walrusResult.error,
        });
        return;
      }

      const metadata = this.storage.get(blobId);

      res.json({
        success: true,
        data: {
          investigation: walrusResult.data,
          metadata: metadata || null,
          blobId: blobId,
        },
      });

    } catch (error: any) {
      console.error('❌ Error retrieving investigation:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve investigation',
        message: error.message,
      });
    }
  }

  private async recordVote(req: Request, res: Response): Promise<void> {
    try {
      const { id: investigationId } = req.params;
      const { voteType, voter, reasoning } = req.body;

      if (!investigationId || !voteType || !voter) {
        res.status(400).json({
          success: false,
          error: 'Investigation ID, vote type, and voter are required',
        });
        return;
      }

      const voteData = {
        investigationId,
        voter,
        voteType,
        reasoning,
        timestamp: new Date().toISOString(),
      };

      const result = await this.grc20Service.recordVote(voteData);

      if (result.success) {
        res.json({
          success: true,
          message: 'Vote recorded successfully',
          data: {
            voteEntityId: result.voteEntityId,
            investigationId,
            voteType,
            voter,
          },
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to record vote',
          details: result.error,
        });
      }

    } catch (error: any) {
      console.error('❌ Error recording vote:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to record vote',
        message: error.message,
      });
    }
  }

  private async getVotes(req: Request, res: Response): Promise<void> {
    try {
      const { id: investigationId } = req.params;

      if (!investigationId) {
        res.status(400).json({
          success: false,
          error: 'Investigation ID is required',
        });
        return;
      }

      const result = await this.grc20Service.getInvestigationVotes(investigationId);

      if (result.success) {
        res.json({
          success: true,
          data: {
            investigationId,
            votes: result.votes,
          },
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to get votes',
          details: result.error,
        });
      }

    } catch (error: any) {
      console.error('❌ Error getting votes:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to get votes',
        message: error.message,
      });
    }
  }

  private async queryInvestigations(req: Request, res: Response): Promise<void> {
    try {
      const { investigationType, severityLevel, status, geographicScope, authorWallet } = req.query;

      const filters: any = {};
      
      if (investigationType) filters.investigationType = investigationType as string;
      if (severityLevel) filters.severityLevel = severityLevel as string;
      if (status) filters.status = status as string;
      if (geographicScope) filters.geographicScope = geographicScope as string;
      if (authorWallet) filters.authorWallet = authorWallet as string;

      console.log('🔍 Querying investigations with filters:', filters);

      const result = await this.grc20Service.queryInvestigations(filters);

      if (result.success) {
        res.json({
          success: true,
          data: {
            investigations: result.investigations,
            count: result.investigations?.length || 0,
            filters: filters,
          },
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to query investigations',
          details: result.error,
        });
      }

    } catch (error: any) {
      console.error('❌ Error querying investigations:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to query investigations',
        message: error.message,
      });
    }
  }

  // Updated Walrus proxy methods to use daemon
  private async storeBlob(req: Request, res: Response): Promise<void> {
    try {
      const { epochs = '5' } = req.query;
      
      const response = await axios.put(`http://127.0.0.1:${WALRUS_DAEMON_PORT}/v1/blobs?epochs=${epochs}`, req.body, {
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/octet-stream',
        },
        timeout: 120000, // Increased timeout
      });

      res.json(response.data);
    } catch (error: any) {
      console.error('Error storing blob:', error.message);
      res.status(error.response?.status || 500).json({
        success: false,
        error: 'Failed to store blob',
        message: error.response?.data?.message || error.message,
      });
    }
  }

  private async getBlob(req: Request, res: Response): Promise<void> {
    try {
      const { blobId } = req.params;
      
      const response = await axios.get(`http://127.0.0.1:${WALRUS_DAEMON_PORT}/v1/blobs/${blobId}`, {
        responseType: 'stream',
        timeout: 60000, // Increased timeout
      });

      if (response.headers['content-type']) {
        res.setHeader('Content-Type', response.headers['content-type']);
      }
      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }

      response.data.pipe(res);
    } catch (error: any) {
      console.error('Error retrieving blob:', error.message);
      res.status(error.response?.status || 404).json({
        success: false,
        error: 'Failed to retrieve blob',
        message: error.response?.data?.message || 'Blob not found',
      });
    }
  }

  private async getApiSpec(req: Request, res: Response): Promise<void> {
    try {
      const response = await axios.get(`http://127.0.0.1:${WALRUS_DAEMON_PORT}/v1/api`);
      res.json(response.data);
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'Failed to get API specification',
        message: error.message,
      });
    }
  }

  public async start(): Promise<void> {
    console.log('🌟 Starting TruETH Protocol Server with Enhanced Walrus Integration...');

    try {
      // Pre-flight checks
      await this.performPreflightChecks();

      // Start Walrus daemon first
      await this.walrusService.startWalrusNodes();

      // Auto-initialize GRC-20 space if environment variables are set
      await this.autoInitializeGRC20Space();

      // Start Express server
      const server = this.app.listen(PORT, () => {
        console.log('');
        console.log('🌟 TruETH Protocol Server is running!');
        console.log(`🌐 Server: http://localhost:${PORT}`);
        console.log(`🔗 Walrus Daemon: http://127.0.0.1:${WALRUS_DAEMON_PORT}`);
        console.log('');
        console.log('📡 Available endpoints:');
        console.log(`  Health: http://localhost:${PORT}/health`);
        console.log(`  Walrus Status: http://localhost:${PORT}/api/walrus/status`);
        console.log(`  Initialize GRC-20 Space: POST http://localhost:${PORT}/api/grc20/initialize-space`);
        console.log(`  AI Entity Extract: POST http://localhost:${PORT}/api/ai/extract-entities`);
        console.log(`  Store Investigation: POST http://localhost:${PORT}/api/investigations/store`);
        console.log(`  Retrieve Investigation: GET http://localhost:${PORT}/api/investigations/retrieve/{blobId}`);
        console.log(`  Record Vote: POST http://localhost:${PORT}/api/investigations/{id}/vote`);
        console.log(`  Get Votes: GET http://localhost:${PORT}/api/investigations/{id}/votes`);
        console.log(`  Query Investigations: GET http://localhost:${PORT}/api/investigations/query`);
        console.log('');
        console.log('🌐 NEW: Hypergraph Direct Query Endpoints:');
        console.log(`  Direct Hypergraph Query: GET http://localhost:${PORT}/api/hypergraph/investigations`);
        console.log(`  Query Specific Space: GET http://localhost:${PORT}/api/hypergraph/space/{spaceId}/investigations`);
        console.log(`  Raw Hypergraph API: GET http://localhost:${PORT}/api/hypergraph/raw/{spaceId}`);
        console.log('');
        console.log('🧪 GRC-20 Test Endpoints:');
        console.log(`  GRC-20 Status: GET http://localhost:${PORT}/api/grc20/status`);
        console.log(`  Query Investigations: GET http://localhost:${PORT}/api/grc20/investigations`);
        console.log(`  Get by Blob ID: GET http://localhost:${PORT}/api/grc20/blob/{blobId}`);
        console.log(`  Get by Investigation ID: GET http://localhost:${PORT}/api/grc20/investigation/{id}`);
        console.log('');
        console.log('🌐 Legacy Walrus Proxy:');
        console.log(`  Store blob: PUT http://localhost:${PORT}/v1/blobs`);
        console.log(`  Get blob: GET http://localhost:${PORT}/v1/blobs/{blobId}`);
        console.log(`  API spec: GET http://localhost:${PORT}/v1/api`);
        console.log('');
        console.log('🌐 GRC-20 Features:');
        console.log('  ✅ The Graph Protocol integration');
        console.log('  ✅ Decentralized knowledge graph');
        console.log('  ✅ Voting and governance');
        console.log('  ✅ Broad investigation categories');
        console.log('  ✅ IPFS + onchain storage');
        console.log('  ✅ Direct Hypergraph querying');
        console.log('');
        console.log('🤖 AI Features:');
        console.log('  ✅ Enhanced entity extraction');
        console.log('  ✅ Investigation categorization');
        console.log('  ✅ Severity assessment');
        console.log('  ✅ Geographic scope detection');
        console.log('');
        console.log('🔗 Walrus Integration:');
        console.log('  ✅ Combined daemon mode (recommended)');
        console.log('  ✅ Enhanced error handling');
        console.log('  ✅ Health monitoring');
        console.log('  ✅ Proper sub-wallet management');
        console.log('');
        console.log('✅ Server is ready for decentralized investigations!');
        console.log('');
        
        // Show GRC-20 status
        const spaceId = this.grc20Service.getSpaceId();
        console.log('🚀 GRC-20 Persistent Space Status:');
        console.log(`  🆔 Space ID: ${spaceId}`);
        console.log('  🔒 Persistent Mode: Enabled (no new spaces created)');
        console.log('  ✅ Ready to query and store investigations!');
        console.log(`  🔗 Try: http://localhost:${PORT}/api/hypergraph/investigations`);
        console.log(`  🔗 Raw API: http://localhost:${PORT}/api/hypergraph/raw/${spaceId}`);
      });

      const shutdown = async (signal: string) => {
        console.log(`\n🔔 Received ${signal}, shutting down gracefully...`);
        
        server.close(() => {
          console.log('🌐 HTTP server closed');
        });

        await this.walrusService.stop();
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (error) {
      console.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  }

  private async performPreflightChecks(): Promise<void> {
    console.log('🔍 Performing pre-flight checks...');

    // Check if Walrus binary exists
    try {
      const { spawn } = require('child_process');
      const walrusCheck = spawn(WALRUS_BINARY_PATH, ['--version'], { stdio: 'pipe' });
      
      await new Promise((resolve, reject) => {
        walrusCheck.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Walrus binary found and accessible');
            resolve(true);
          } else {
            reject(new Error(`Walrus binary check failed with code ${code}`));
          }
        });
        
        walrusCheck.on('error', (error) => {
          reject(new Error(`Walrus binary not found: ${error.message}`));
        });
      });
    } catch (error: any) {
      console.error('❌ Walrus binary check failed:', error.message);
      console.error('💡 Please install Walrus binary:');
      console.error('💡 Download from: https://storage.googleapis.com/mysten-walrus-binaries/');
      console.error('💡 Or set WALRUS_BINARY_PATH environment variable');
      throw error;
    }

    // Check wallets directory
    const walletsDirExpanded = PUBLISHER_WALLETS_DIR.replace('~', process.env.HOME || '');
    console.log(`📁 Wallets directory: ${walletsDirExpanded}`);

    console.log('✅ Pre-flight checks completed');
  }

  private async autoInitializeGRC20Space(): Promise<void> {
    try {
      console.log('🔄 Loading persistent GRC-20 space configuration...');
      
      // Always load existing schema from the persistent space
      await this.grc20Service.loadExistingSchema();
      
      // Display schema information on startup
      this.grc20Service.displaySchemaInfo();

      // Check if we need to initialize any missing schema elements
      const geoPrivateKey = process.env.GEO_PRIVATE_KEY || process.env.GRC20_PRIVATE_KEY;
      const defaultEditorAddress = process.env.GRC20_EDITOR_ADDRESS;

      if (geoPrivateKey && defaultEditorAddress) {
        console.log('🔧 Ensuring schema is complete...');
        
        await this.grc20Service.initializeSpace({
          name: 'TruETH Investigations',
          description: 'Decentralized investigation verification platform',
          category: 'Investigation',
          editorAddress: defaultEditorAddress,
          network: 'TESTNET',
        });

        console.log('✅ GRC-20 persistent space ready');
      } else {
        console.log('ℹ️ Schema loaded in read-only mode');
        console.log('  Set GEO_PRIVATE_KEY and GRC20_EDITOR_ADDRESS for full functionality');
      }
    } catch (error) {
      console.warn('⚠️ Failed to load GRC-20 space configuration:', (error as Error).message);
      console.log('ℹ️ Using fallback mode for this session');
    }
  }
}

// Initialize and start the server
const server = new TruETHServer();

if (require.main === module) {
  server.start().catch((error) => {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  });
}

export default TruETHServer;