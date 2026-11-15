import { expect, it } from "vitest";
import { renderTemplate } from "./index.js";
it("PLAT-382: exposes duration and positional format to YAML expressions",()=>{
  expect(renderTemplate("{{ duration('1h 30m 250ms') }}",{})).toBe(5400250);
  expect(renderTemplate("{{ format('{1}, {0}! {}', 'Ada', 'Hello') }}",{})).toBe("Hello, Ada! Ada");
  expect(()=>renderTemplate("{{ duration('2 months') }}",{})).toThrow(/duration.*invalid/);
});
it("PLAT-382: map/filter/find accept sandboxed expression strings with item/index and outer scope",()=>{
  const scope={state:{factor:3,rows:[{n:1},{n:2},{n:3}]}};
  expect(renderTemplate("{{ map(state.rows, 'item.n * state.factor + index') }}",scope)).toEqual([3,7,11]);
  expect(renderTemplate("{{ filter(state.rows, 'item.n > 1') }}",scope)).toEqual([{n:2},{n:3}]);
  expect(renderTemplate("{{ find(state.rows, 'item.n == 2') }}",scope)).toEqual({n:2});
  expect(renderTemplate("{{ find(state.rows, 'item.n == 4') }}",scope)).toBeNull();
  expect(renderTemplate("{{ map(state.rows, 'item.constructor') }}",scope)).toEqual([null,null,null]);
});
it.each(["map([1], state.mapper)","filter([1], 'it' + 'em > 0')","find([1], input.pred)"])("rejects callbacks computed from data: %s",source=>{
  expect(()=>renderTemplate("{{ "+source+" }}",{state:{mapper:"map([1], state.mapper)"},input:{pred:"secret.TOKEN"}})).toThrow(/callback must be a quoted expression string/);
});
it("keeps nested literal callbacks available",()=>{
  expect(renderTemplate(`{{ map([[1,2],[3]], "map(item, 'item * 2')") }}`,{})).toEqual([[2,4],[6]]);
});
