import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test,expect} from 'vitest';
import {ConsideredSection} from '../../src/renderer/src/strategies/BasketPanel';

test('candidates left out show as one collapsed line with their count, and nothing when there are none',()=>{
 const html=renderToStaticMarkup(createElement(ConsideredSection,{considered:[{subject:'OKLO',reason:'Pre-revenue.'},{subject:'Uranium miners',reason:'Covered by URA.'}]}));
 expect(html).toContain('Considered, not included (2)');expect(html).toContain('aria-expanded="false"');expect(html).not.toContain('Pre-revenue.');
 expect(renderToStaticMarkup(createElement(ConsideredSection,{considered:[]}))).toBe('');
});
