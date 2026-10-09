import { Connection } from "@solana/web3.js";
import { decodeOrderBook, orderBookPda, marketPda } from "fructus-sdk/src/index.js";
const c = new Connection("http://127.0.0.1:8899", "confirmed");
const book = orderBookPda(marketPda().address).address;
const acc = await c.getAccountInfo(book);
const st = decodeOrderBook(acc.data);
console.log(JSON.stringify({
  bestBid: st.bestBid?.toString(), bestAsk: st.bestAsk?.toString(),
  bids: st.bids.map(o => ({ seq: o.seq.toString(), price: o.price.toString(), size: o.size.toString(), owner: o.owner.toBase58().slice(0,8) })),
  asks: st.asks.map(o => ({ seq: o.seq.toString(), price: o.price.toString(), size: o.size.toString(), owner: o.owner.toBase58().slice(0,8) })),
}, null, 1));
