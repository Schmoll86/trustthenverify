#!/usr/bin/env node
/**
 * Seed TTV Marketplace — Production
 *
 * 1. Registers 8 demo agents with real capabilities
 * 2. Creates 5 verification policies via SDK
 * 3. Activates + publicizes policies via Supabase Management API
 */

import {
  generateKeypair,
  createAgent,
  TrustProtocol,
} from '../packages/sdk/dist/index.js';

const API = process.env.TTV_API_URL || 'https://api.trustthenverify.com/v2';
const SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'dlhtzfkcdrvfsehegtyo';
const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_ACCESS_TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN env var required (sbp_...). Get one at https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

const log = (msg) => console.log(`  ${msg}`);

// ─── Agent definitions ──────────────────────────────────────────────────────
const AGENTS = [
  { name: 'CodeReview-Bot', capabilities: ['code-review', 'static-analysis', 'security-audit'] },
  { name: 'WebSearch-Agent', capabilities: ['web-search', 'data-retrieval', 'summarization'] },
  { name: 'DataAnalysis-Pro', capabilities: ['data-analysis', 'visualization', 'statistical-modeling'] },
  { name: 'TranslationService', capabilities: ['translation', 'localization', 'content-adaptation'] },
  { name: 'ContentWriter-AI', capabilities: ['content-creation', 'copywriting', 'technical-writing'] },
  { name: 'SmartContract-Auditor', capabilities: ['smart-contract-audit', 'security-audit', 'solidity'] },
  { name: 'APITesting-Agent', capabilities: ['api-testing', 'integration-testing', 'load-testing'] },
  { name: 'DesignReview-Bot', capabilities: ['design-review', 'accessibility-audit', 'ux-analysis'] },
];

// ─── Policy definitions ─────────────────────────────────────────────────────
const POLICIES = [
  {
    name: 'Code Quality Gate',
    intent: 'Ensure code review deliverables meet quality standards with no critical issues.',
    description: 'Validates that code review output contains structured findings, severity ratings, and no critical security vulnerabilities remain unaddressed.',
  },
  {
    name: 'Research Report Standard',
    intent: 'Validate research deliverables include sources, methodology, and structured conclusions.',
    description: 'Ensures research output has cited sources, clear methodology description, and actionable conclusions with confidence levels.',
  },
  {
    name: 'Translation Accuracy',
    intent: 'Ensure translations preserve meaning, tone, and technical terminology.',
    description: 'Validates translated content maintains semantic accuracy, proper formatting, and domain-specific terminology consistency.',
  },
  {
    name: 'Data Pipeline SLA',
    intent: 'Verify data processing output meets completeness and format requirements.',
    description: 'Ensures data pipeline deliverables contain all expected fields, proper data types, and meet minimum record count thresholds.',
  },
  {
    name: 'API Integration Test Suite',
    intent: 'Validate API integration test results cover all endpoints with passing assertions.',
    description: 'Ensures test suite output includes coverage metrics, individual test results with pass/fail status, and no failing critical path tests.',
  },
];

// ─── Supabase Management API helper ─────────────────────────────────────────
async function runSQL(sql) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase SQL failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Seeding TrustThenVerify Marketplace (Production)');
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── Phase 1: Register agents ──────────────────────────────────────────────
  console.log('Phase 1: Registering marketplace agents...\n');
  let firstProtocol = null;

  for (const agent of AGENTS) {
    try {
      const keys = generateKeypair();
      await createAgent({
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        name: agent.name,
        capabilities: agent.capabilities,
        sandbox: false,
        apiUrl: API,
      });
      log(`Registered: ${agent.name} (${keys.publicKey.slice(0, 16)}...)`);

      // Save first protocol for policy creation
      if (!firstProtocol) {
        firstProtocol = new TrustProtocol({
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
          apiUrl: API,
          sandbox: false,
        });
      }
    } catch (err) {
      log(`Failed: ${agent.name} — ${err.message}`);
    }
  }

  if (!firstProtocol) {
    console.error('\nNo agents registered — cannot create policies.');
    process.exit(1);
  }

  // ── Phase 2: Create policies ──────────────────────────────────────────────
  console.log('\nPhase 2: Creating verification policies...\n');
  const policyIds = [];

  for (const template of POLICIES) {
    try {
      const policy = await firstProtocol.createPolicy({
        name: template.name,
        intent: template.intent,
        description: template.description,
      });
      log(`Created: ${template.name} (${policy.id})`);
      policyIds.push(policy.id);
    } catch (err) {
      log(`Failed: ${template.name} — ${err.message}`);
    }
  }

  if (policyIds.length === 0) {
    console.error('\nNo policies created.');
    process.exit(1);
  }

  // ── Phase 3: Activate + publicize via Supabase ────────────────────────────
  console.log('\nPhase 3: Activating and publishing policies...\n');

  const idList = policyIds.map(id => `'${id}'`).join(', ');
  const sql = `UPDATE policies SET status = 'active', visibility = 'public' WHERE id IN (${idList}) RETURNING id, name, status, visibility;`;

  try {
    const result = await runSQL(sql);
    log(`Updated ${Array.isArray(result) ? result.length : '?'} policies to active + public`);
    if (Array.isArray(result)) {
      for (const row of result) {
        log(`  ${row.name}: ${row.status} / ${row.visibility}`);
      }
    } else {
      console.log('  Result:', JSON.stringify(result, null, 2));
    }
  } catch (err) {
    log(`Supabase update failed: ${err.message}`);
    log('Trying individual updates...');

    for (const id of policyIds) {
      try {
        await runSQL(`UPDATE policies SET status = 'active', visibility = 'public' WHERE id = '${id}';`);
        log(`  Activated: ${id.slice(0, 8)}...`);
      } catch (e2) {
        log(`  Failed: ${id.slice(0, 8)}... — ${e2.message}`);
      }
    }
  }

  // ── Phase 4: Verify marketplace ───────────────────────────────────────────
  console.log('\nPhase 4: Verifying marketplace...\n');

  const res = await fetch(`${API}/marketplace`);
  const json = await res.json();
  const count = json.data?.length ?? 0;

  log(`Marketplace now has ${count} public policies:`);
  if (json.data) {
    for (const p of json.data) {
      log(`  - ${p.name} (${p.billingModel || 'free'}) — "${p.intent?.slice(0, 60)}..."`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Marketplace seeded! Visit: https://trustthenverify.com/marketplace');
  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
