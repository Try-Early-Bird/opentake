import {test,expect} from 'vitest';
import {versionChanges} from '../../src/renderer/src/strategies/TakeVersionChanges';
test('version review counts changed allocations and rules, including removed assets',()=>{
 const rules={cashBps:0,schedule:'never' as const,driftBandPoints:5,driftBandRelative:null};
 const result=versionChanges({currentWeights:[{symbol:'BTC',bps:5000},{symbol:'ZEC',bps:5000}],nextWeights:[{symbol:'BTC',bps:10000}],currentRules:rules,nextRules:{...rules,schedule:'monthly'}});
 expect(result.allocations).toEqual([{label:'BTC',before:50,after:100},{label:'ZEC',before:50,after:0}]);
 expect(result.rules).toEqual([{label:'Schedule',before:'Drift only',after:'Monthly'}]);
 expect(result.unchanged).toEqual(['Cash target','Drift threshold','Relative drift']);
});
