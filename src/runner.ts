// src/runner.ts
// Single Responsibility: Orchestrate the fetching of plugins sequentially per category, respecting global deadlines.

import fs from 'node:fs';
import path from 'node:path';

import { fetchCommunityPlugins } from './discovery.js';
import { fetchPluginData } from './fetch/fetch-index.js';
import { writeJsonAtomic, readJsonSafe } from './fileUtils.js';

import type { DiscoveredPlugin } from './discovery.js';

const MAX_DURATION_MS = 5.5 * 60 * 60 * 1000; // 5.5 hours

async function processCategory(
  plugins: readonly DiscoveredPlugin[],
  dataDir: string,
  pat: string,
  label: string,
  deadline: number
): Promise<void> {
  console.log(`\n📂 [${label}] Processing Category...`);
  
  if (plugins.length === 0) {
    console.log(`📦 [${label}] No plugins found. Skipping.`);
    return;
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`📁 [${label}] Created data directory: ${dataDir}`);
  }

  const total: number = plugins.length;
  console.log(`📦 [${label}] Found ${total} plugins to process.`);
  console.log("-----------------------------------------------");

  let completed = 0;
  let skipped = 0;
  let successCount = 0;
  let failCount = 0;

  for (const plugin of plugins) {
    // 1. Check Global Deadline
    if (Date.now() > deadline) {
      console.log(`⏳ [${label}] Global deadline exceeded at ${new Date().toISOString()}. Stopping process.`);
      break;
    }

    const filePath: string = path.join(dataDir, `${plugin.id}.json`);
    let shouldFetch = true;

    // 2. Checkpoint Logic
    if (fs.existsSync(filePath)) {
      try {
        const parsed = readJsonSafe<{ readonly now: string }>(filePath);
        const fetchedAt = new Date(parsed.now).getTime();
        const ageHours = (Date.now() - fetchedAt) / (1000 * 60 * 60);
        
        if (ageHours < 6) {
          console.log(`⏭️  [${label}] [${String(completed + 1).padStart(4, ' ')}/${total}] ${plugin.id.padEnd(30)} SKIPPED (Fresh: ${ageHours.toFixed(1)}h old)`);
          skipped++;
          completed++;
          shouldFetch = false;
        } else {
          console.log(`🔄 [${label}] [${String(completed + 1).padStart(4, ' ')}/${total}] ${plugin.id.padEnd(30)} STALE (Age: ${ageHours.toFixed(1)}h) -> Re-fetching`);
        }
      } catch (e) {
        console.warn(`⚠️ [${label}] [${plugin.id}] Existing file corrupted or invalid. Re-fetching. Error:`, e);
      }
    } else {
      console.log(`🆕 [${label}] [${String(completed + 1).padStart(4, ' ')}/${total}] ${plugin.id.padEnd(30)} NEW -> Fetching`);
    }

    if (!shouldFetch) {
      continue;
    }

    const pluginStart: number = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await fetchPluginData({ pat, repo: plugin.repo }, deadline);

      if (result.isOk()) {
        // Atomic Write to prevent data corruption
        writeJsonAtomic(filePath, result.value);
        
        successCount++;
        const duration: number = Date.now() - pluginStart;
        console.log(`✅ [${label}] [${String(completed + 1).padStart(4, ' ')}/${total}] ${plugin.id.padEnd(30)} SUCCESS (${duration}ms)`);
      } else {
        const errData = result.error;
        if (errData.kind === "DeadlineExceededError") {
          console.log(`⏳ [${label}] Rate limit wait exceeds deadline for ${plugin.id}. Stopping.`);
          break;
        }
        failCount++;
        console.error(`❌ [${label}] [${String(completed + 1).padStart(4, ' ')}/${total}] ${plugin.id.padEnd(30)} FAILED: [${errData.kind}] ${errData.message}`);
        if ('issues' in errData) {
          console.error(`   Validation Issues:`, JSON.stringify(errData.issues));
        }
      }
    } catch (err: unknown) {
      failCount++;
      const msg: string = err instanceof Error ? err.message : String(err);
      console.error(`💥 [${label}] [${String(completed + 1).padStart(4, ' ')}/${total}] ${plugin.id.padEnd(30)} CRITICAL EXCEPTION: ${msg}`);
    } finally {
      completed++;
    }
  }

  console.log("-----------------------------------------------");
  console.log(`🏁 [${label}] FETCH STOPPED/COMPLETE`);
  console.log(`⏭️  Skipped (Fresh): ${skipped}`);
  console.log(`✅ Successful:      ${successCount}`);
  console.log(`❌ Failed:          ${failCount}`);
  console.log(`📊 Total Processed: ${successCount + failCount}`);
  console.log("-----------------------------------------------");
}

async function main(): Promise<void> {
  const startTime: number = Date.now();
  const deadline: number = startTime + MAX_DURATION_MS;
  
  console.log("=================================================");
  console.log("🚀 STARTING PLUGIN DATA FETCH");
  console.log(`🕒 Started at: ${new Date(startTime).toISOString()}`);
  console.log(`🛑 Deadline:   ${new Date(deadline).toISOString()}`);
  console.log("=================================================");

  const pat: string | undefined = process.env["PAT_1"];
  if (!pat) {
    throw new Error("❌ No PAT provided. Please set GITHUB_TOKEN or PAT_1.");
  }

  console.log("📥 Fetching plugin metadata lists...");
  const discoveredPlugins: DiscoveredPlugin[] = await fetchCommunityPlugins();

  // 1. Sort alphabetically by name (A to Z)
  // 2. Ignore the first 1000 plugins
  // 3. Handle the second 1000 plugins (indices 1000 to 1999)
  const sortedPlugins: DiscoveredPlugin[] = [...discoveredPlugins]
    .sort((a: DiscoveredPlugin, b: DiscoveredPlugin): number => a.name.localeCompare(b.name))
    .slice(2000, 3000);

  console.log(`📊 Total discovered: ${discoveredPlugins.length}`);
  console.log(`📊 Selected range (2000-3000): ${sortedPlugins.length} plugins`);

  if (sortedPlugins.length === 0) {
    console.log("ℹ️ No plugins found in the specified range (2000-3000). Execution finished.");
    return;
  }

  // Process categories sequentially to respect rate limits and logic clarity
  await processCategory(
    sortedPlugins, 
    path.join(process.cwd(), 'data'), 
    pat, 
    "Community (Batch 2)", 
    deadline
  );

  const totalDurationMinutes: string = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  console.log("=================================================");
  console.log(`⏱️  Total Duration: ${totalDurationMinutes} minutes`);
  console.log("=================================================");
}

main().catch((err: unknown) => {
  const msg: string = err instanceof Error ? err.message : String(err);
  console.error("\n🛑 FATAL RUNNER ERROR:", msg);
  process.exit(1);
});
