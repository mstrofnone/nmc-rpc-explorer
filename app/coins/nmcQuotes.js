// Curated Namecoin quotes, facts, and notable dates.
//
// Sources:
//   - bitcointalk.org topic #6017 (Vincent Durham's announcement of Namecoin)
//   - bitcointalk.org topic #236340 (the [NMC] Namecoin News Thread,
//     authored by namecoin.info / phelix)
//   - bitcointalk.org topic #1790 (Gavin Andresen's "Distributed DNS"
//     thread, the BitDNS discussion that Vincent cites as inspiration)
//   - github.com/namecoin (Namecoin Core, ncdns, electrum-nmc,
//     dot-bit website, the canonical client implementations)
//
// The shape mirrors app/coins/btcQuotes.js (`text`, `speaker`, `date`,
// `url`, optional `context`) so it can be passed to the existing
// `+quote()` mixin in views/includes/shared-mixins.pug without any
// extra plumbing.

module.exports = {
	items: [
		{
			text: "Namecoin is a naming system based on bitcoin with a few modifications. It is inspired by the bitdns discussion and recent failures of the DNS.",
			speaker: "Vincent Durham (vinced)",
			date: "2011-04-18",
			url: "https://bitcointalk.org/index.php?topic=6017.msg88356#msg88356",
			context: "the original Namecoin announcement on bitcointalk.org"
		},
		{
			text: "Like Bitcoin means freedom for money, Namecoin means freedom for information.",
			speaker: "phelix",
			date: "2013-06-17",
			url: "https://bitcointalk.org/index.php?topic=236340.0",
			context: "opening of the [NMC] Namecoin News Thread"
		},
		{
			text: "Namecoin was the first fork of the Bitcoin codebase, the first altcoin, and the first cryptocurrency to deploy merged mining — letting Bitcoin miners secure a second chain at no extra hashing cost.",
			speaker: "Namecoin Project",
			date: "2011-10-21",
			url: "https://github.com/namecoin/namecoin-core",
			context: "merged mining (AuxPoW) activated on Namecoin at block 19,200"
		},
		{
			text: "BitDNS and Generalizing Bitcoin — could you guys [Bitcoin developers] go in 50/50 on a new system? […] this idea is good, it should be done as a separate network and a separate block chain, yet share CPU power with Bitcoin.",
			speaker: "Satoshi Nakamoto",
			date: "2010-12-09",
			url: "https://bitcointalk.org/index.php?topic=1790.msg28744#msg28744",
			context: "Satoshi's reply in the BitDNS thread that became Namecoin"
		},
		{
			text: "The Namecoin genesis block was mined on April 18, 2011 — block 0 hash 000000000062b72c5e2ceb45fbc8587e807c155b0da735e6483dfba2f0a9c770. Its coinbase scriptSig contains the message: '…Namecoin a merged-mining currency peer-to-peer'.",
			speaker: "Namecoin Genesis",
			date: "2011-04-18",
			url: "./block-height/0",
			context: "the start of the Namecoin blockchain"
		},
		{
			text: "Names live in namespaces. d/<name> is a domain in the .bit TLD; id/<name> is a NameID identity record; dd/<name> stores domain sub-records that other names import. Namespaces are convention, not enforced by consensus — anyone can register any prefix.",
			speaker: "Namecoin docs",
			date: "2014",
			url: "https://github.com/namecoin/proposals",
			context: "ICANN's TLDs are gatekept; .bit's are not"
		},
		{
			text: "A name expires 36,000 blocks (~250 days) after its last name_update. Renew before then and your name is yours forever; let it lapse and anyone can re-register it.",
			speaker: "Namecoin Core",
			date: "2015",
			url: "https://github.com/namecoin/namecoin-core/blob/master/doc/namecoin.md",
			context: "since the post-Huntercoin name expiry change"
		},
		{
			text: "Namecoin Core is the reference full node. ncdns is the DNS bridge that resolves .bit domains. Electrum-NMC is the SPV wallet. ConsensusJ-Namecoin powers light clients. The whole stack lives at github.com/namecoin.",
			speaker: "Namecoin Project",
			date: "ongoing",
			url: "https://github.com/namecoin",
			context: "the canonical Namecoin software ecosystem"
		},
		{
			text: "Names are property. Identity is property. Free speech is property. Namecoin lets you own them — without permission, without renewal fees to a registrar, and without a central authority who can take them away.",
			speaker: "Namecoin Project",
			date: "ongoing",
			url: "https://www.namecoin.org/",
			context: "the project's stated mission"
		},
	]
};
