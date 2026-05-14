import { readFileSync, writeFileSync } from 'node:fs';

const inputPath = '/Users/jeremiahcrouse/good-citizen-node/src/SystemPrompt.md';
const outputPath = '/Users/jeremiahcrouse/good-citizen-node/src/SystemPrompt.txt';

try {
  const content = readFileSync(inputPath, 'utf8');
  // Replace all sequences of line breaks (including \r and \n) with a single semicolon
  const processed = content.replace(/[\r\n]+/g, ';');
  writeFileSync(outputPath, processed, 'utf8');
  console.log(`Successfully converted prompt to single-line format: ${outputPath}`);
} catch (error) {
  console.error(`Error converting prompt: ${error.message}`);
}