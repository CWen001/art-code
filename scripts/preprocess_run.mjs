#!/usr/bin/env node
import { runPreprocessCli } from '../preprocess/pipeline.mjs';

runPreprocessCli(process.argv)
  .then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  })
  .catch((error) => {
    console.error('preprocess_run failed:', error instanceof Error ? error.message : String(error));
    process.exit(2);
  });

