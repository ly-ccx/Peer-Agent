import { runInteractiveValidation } from '../validation.mjs';

if (process.argv.includes('--help')) process.stdout.write('interactive-validation-probe\n');
else {
  const content = await runInteractiveValidation({ operation: 'validate', draft: { title: 'Compiled', textFallback: 'Fixed trial.',
    program: '$budget=10\nroot=Metric("Total",$budget*3)' }, bindings: {} });
  const evaluated = await runInteractiveValidation({ operation: 'evaluate', content, values: { $budget: 20 } });
  if (evaluated.tree.props.value !== 60) throw Error('compiled_evaluation_mismatch');
  process.stdout.write(JSON.stringify({ engine: content.engine, specHash: content.specHash, value: evaluated.tree.props.value }) + '\n');
}
