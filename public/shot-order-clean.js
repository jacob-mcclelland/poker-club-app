// Normalize a shotRounds document before a page renders it.
//
// Any device with an anonymous account can write shot orders (firestore.rules
// checks the top-level fields but cannot look inside every player and shot),
// so one malformed card must not stop bar.html or shots.html from rendering
// the rest. Players and shots that are not objects are dropped; names, types
// and notes become strings and quantities become numbers.
// Pure, no imports: scripts/shot-order-clean-test.js runs it under Node.

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)));

export function cleanOrder(data) {
  const order = isObject(data) ? data : {};
  const players = (Array.isArray(order.players) ? order.players : [])
    .filter(isObject)
    .map(p => {
      const shots = (Array.isArray(p.shots) ? p.shots : [])
        .filter(isObject)
        .map(s => {
          const shot = Object.assign({}, s, { type: text(s.type), qty: Number(s.qty) || 0 });
          if ('note' in s) shot.note = text(s.note);
          return shot;
        });
      return Object.assign({}, p, { name: text(p.name), shots });
    });
  const submitter = isObject(order.submitter) ? Object.assign({}, order.submitter, { name: text(order.submitter.name) }) : { name: '' };
  return Object.assign({}, order, { players, submitter });
}
