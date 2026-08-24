# Capital / investment spend routed through expenses — niko (Zoho books)

Source: full Zoho dump in `.zoho-dump` — 21559 ledger postings, 2023-12-05 → 2026-08-13. Every journal, bill and expense was scanned.

## Summary

| | What | Count | Amount |
|---|---|---:|---:|
| A | Expense→balance-sheet reclassification journals | 1 | ₹67,66,705 |
| B | Postings building the two LLP investment accounts | 160 | ₹15,87,89,491 Dr / ₹4,25,80,011 Cr |
| C | Capital spend entered through the Expense module | 266 | ₹4,31,11,623 |
| D | Capital-looking spend still sitting in expense accounts | 15 | ₹5,41,174 |

There is exactly **one** journal in the whole file that moves cost out of the P&L onto the balance sheet — JE 125. The much larger population is section C: capital and investment spend that never touched an expense *account*, but was keyed through the Expense *module* (a cash/bank payment voucher) instead of a vendor bill.

## A. Reclassification journals (expense credited → balance-sheet account debited)

### JE 125 — 2025-03-31 — PROFIT AND LOSS ACCOUNT CONVERT TO PRE OPERATING EXPENSES

Capitalised **₹67,66,705** into **Pre opretaing Expenses** (other_current_asset), out of 27 P&L accounts:

| # | Expense account credited | Amount |
|---:|---|---:|
| 1 | Salaries and Employee Wages | ₹14,60,289 |
| 2 | Legal & Professional Expenses | ₹10,92,356 |
| 3 | Cars & Bikes Petrol Expenses | ₹9,32,636 |
| 4 | ROC Filing Fees | ₹5,80,850 |
| 5 | Bank Charges | ₹5,30,533 |
| 6 | Interest on Term Loan (43766492854) | ₹4,84,659 |
| 7 | Travelling & Conveyance | ₹3,14,094 |
| 8 | License fee | ₹2,16,400 |
| 9 | SBI General Insurance Expenses | ₹1,86,440 |
| 10 | Security Charges (Nabil) | ₹1,40,675 |
| 11 | Office Expenses (Thelamara) | ₹1,36,968 |
| 12 | Vehicle Maintenance | ₹1,24,617 |
| 13 | Printing & Stationery Expenses | ₹1,23,593 |
| 14 | Office Rent Expenses | ₹90,000 |
| 15 | Software Expenses | ₹87,099 |
| 16 | Rates & Taxes | ₹75,068 |
| 17 | Staff & Director Welfare Expenses | ₹64,792 |
| 18 | Cook Room Rent Expenses | ₹31,800 |
| 19 | Room Rent Expenses | ₹23,500 |
| 20 | Electrical Expenses | ₹21,667 |
| 21 | GVR Sir Room Rent | ₹14,000 |
| 22 | Internet WiFi & Telephone Expenses | ₹11,906 |
| 23 | Self Asst Tax | ₹6,113 |
| 24 | Farm Expenses (Nabil) | ₹6,010 |
| 25 | Application Fee | ₹5,200 |
| 26 | Roadways,Freight & Transportation Expenses  (Nabil) | ₹4,870 |
| 27 | Postage & Courier Expenses | ₹570 |
| | **Total** | **₹67,66,705** |

## B. The two LLP investment accounts — every posting

### Investment in Nandammuri Poultries LLP — 74 postings, net ₹6,81,74,490

| Date | Doc type | Dr | Cr | Paid through / offset | Narration |
|---|---|---:|---:|---|---|
| 2024-09-14 | expense | ₹15,044 |  | ICICI A/C - 058805501402 | LEI Registration 3 YEARS |
| 2024-09-30 | expense | ₹18,00,000 |  | ICICI A/C - 058805501402 | Investment — Investment |
| 2024-10-21 | expense | ₹61,84,957 |  | ICICI A/C - 058805501402 | Nandamuri Poultries LLP |
| 2025-02-11 | transfer_fund | ₹20,00,000 |  | Amino SBI Current A/C-43311518227 |  |
| 2025-05-19 | expense | ₹35,00,000 |  | Amino SBI Current A/C-43311518227 | INVEST IN NANDAMURI POultries — INVEST IN NANDAMURI POultries |
| 2025-06-10 | transfer_fund | ₹15,00,000 |  | Amino SBI Current A/C-43311518227 | Amount Transfer to Nandamuri Poultries LLP |
| 2025-06-17 | transfer_fund | ₹5,00,000 |  | Amino SBI Current A/C-43311518227 | Transfer to Nandamuri Poultries |
| 2025-06-24 | transfer_fund | ₹25,00,000 |  | Amino SBI Current A/C-43311518227 | Nandamuri Poultries LLP SBI Current Account |
| 2025-06-30 | transfer_fund | ₹2,00,000 |  | Amino SBI Current A/C-43311518227 | Nandamuri Poultries sbi current Account |
| 2025-07-24 | transfer_fund | ₹50,00,000 |  | Amino SBI Current A/C-43311518227 | Amount Transfer to Nandamuri Poultries LLP |
| 2025-07-24 | transfer_fund | ₹10,00,000 |  | Amino SBI Current A/C-43311518227 | Amount Transfer to Nandamuri Poultries LLP |
| 2025-07-24 | transfer_fund | ₹20,00,000 |  | Amino SBI Current A/C-43311518227 | Amount transfer to nandamuri poultries llp |
| 2025-07-24 | transfer_fund | ₹40,00,000 |  | Amino SBI Current A/C-43311518227 | Amount transfer to nandamuri poultries LLP |
| 2025-07-29 | transfer_fund | ₹5,00,000 |  | Amino SBI Current A/C-43311518227 | Amount Transfer to Nandamuri poultries LLP |
| 2025-08-26 | transfer_fund | ₹45,50,000 |  | Amino SBI Current A/C-43311518227 | Nandamuri poultries sbi current account |
| 2025-08-30 | transfer_fund | ₹3,00,000 |  | Amino SBI Current A/C-43311518227 | Nandamuri Poultries sbi current account |
| 2025-09-08 | transfer_fund | ₹2,00,000 |  | Amino SBI Current A/C-43311518227 | CMP000000012416885NANDAMURI POULTRIESLLP |
| 2025-09-13 | transfer_fund | ₹11,35,000 |  | Amino SBI Current A/C-43311518227 | Transfer to Nandamuri sbi current account |
| 2025-09-16 | transfer_fund | ₹2,00,000 |  | Amino SBI Current A/C-43311518227 | Nandamuri Poultries sbi current account |
| 2025-09-19 | transfer_fund | ₹50,000 |  | Amino SBI Current A/C-43311518227 | 43365717966 NANDAMURI POULTRIESLLP |
| 2025-09-30 | transfer_fund | ₹5,30,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001266430116AOYJ153087NANDAMURI |
| 2025-10-07 | transfer_fund | ₹35,00,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001270169256AOYM279528NANDAMURI |
| 2025-10-31 | transfer_fund | ₹5,60,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0131102512832/NAN DAMURI POULTRIESLLP- |
| 2025-11-06 | transfer_fund | ₹15,00,000 |  | Amino SBI Current A/C-43311518227 | CT00WQXWT7 TRANSFER TO 43365717966 NANDAMURI |
| 2025-11-18 | transfer_fund | ₹40,00,000 |  | Amino SBI CC Account-44656290967 | Amount transferd to nandamuri sbi current account |
| 2025-12-01 | transfer_fund | ₹10,00,000 |  | Amino SBI CC Account-44656290967 | TRANSFER TO 43365717966 NANDAMURI POULTRIESLLP / |
| 2025-12-08 | transfer_fund | ₹20,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0108122513541/NAN DAMURI POULTRIESLLP |
| 2025-12-08 | transfer_fund | ₹45,00,000 |  | Amino SBI CC Account-44656290967 | CT00XWTIY7 TRANSFER TO NANDAMURI POULTRIESLLP |
| 2025-12-08 | transfer_fund | ₹45,00,000 |  | Amino SBI CC Account-44656290967 | CT00XWTLD0 TRANSFER TO NANDAMURI POULTRIESLLP |
| 2025-12-08 | transfer_fund | ₹10,00,000 |  | Amino SBI CC Account-44656290967 | CT00XWTQN1 NANDAMURI POULTRIESLLP / |
| 2025-12-19 | transfer_fund | ₹6,00,000 |  | Amino SBI Current A/C-43311518227 | CT00YHWCO9 TRANSFER NANDAMURI POULTRIESLLP |
| 2025-12-22 | transfer_fund | ₹1,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0122122549011/Nandamuri Poultries |
| 2025-12-24 | transfer_fund | ₹4,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/01241225556116/Nandamuri Poultries LLP |
| 2025-12-29 | transfer_fund | ₹8,50,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/01291225520110/Nandamuri Poultries |
| 2026-01-17 | transfer_fund | ₹62,00,000 |  | Undeposited Funds |  |
| 2026-01-22 | transfer_fund | ₹2,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0122012641668/Nandamuri Poultries LLP |
| 2026-01-30 | transfer_fund | ₹9,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/3001260025474/NAN DAMURI POULTRIESLLP |
| 2026-02-09 | transfer_fund | ₹50,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0902260042244/Nandamuri Poultries |
| 2026-02-27 | transfer_fund | ₹2,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2702260047582/NAN DAMURI POULTRIESLLP |
| 2026-04-01 | transfer_fund | ₹99,000 |  | Undeposited Funds |  |
| 2026-04-01 | transfer_fund | ₹25,000 |  | Undeposited Funds |  |
| 2026-04-01 | transfer_fund | ₹1,07,900 |  | Undeposited Funds | paul egg center amount from nandamuri poultries |
| 2026-04-02 | transfer_fund | ₹9,57,600 |  | Undeposited Funds | NANDAMURI LLP |
| 2026-04-18 | transfer_fund | ₹4,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1804260016846/NAN DAMURI POULTRIESLLP |
| 2026-04-22 | transfer_fund | ₹4,30,000 |  | Amino SBI Current A/C-43311518227 | /2204260015280/NAN DAMURI POULTRIESLLP |
| 2026-04-28 | transfer_fund |  | ₹40,00,000 | Amino SBI CC Account-44656290967 | 44959290204 NANDAMURI POULTRIESLLP |
| 2026-04-30 | transfer_fund | ₹26,85,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/3004260065812/NAN DAMURI POULTRIESLLP |
| 2026-05-05 | transfer_fund | ₹2,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0505260032287/NAN DAMURI POULTRIESLLP |
| 2026-05-07 | transfer_fund | ₹50,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0705260086756/NAN DAMURI POULTRIESLLP |
| 2026-05-08 | transfer_fund | ₹8,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0805260037214/NAN DAMURI POULTRIESLLP |
| 2026-05-11 | transfer_fund |  | ₹35,00,000 | Amino SBI CC Account-44656290967 | 44959290204 NANDAMURI POULTRIESLLP |
| 2026-05-13 | transfer_fund | ₹3,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1305260024785/NAN DAMURI POULTRIESLLP |
| 2026-05-14 | transfer_fund | ₹1,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1405260017919/NAN DAMURI POULTRIESLLP |
| 2026-05-16 | transfer_fund | ₹6,00,000 |  | Amino SBI CC Account-44656290967 | Transfer to Nandamuri Poultries/ 1605260021617/ |
| 2026-05-22 | transfer_fund | ₹50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2205260000935/NAN DAMURI POULTRIESLLP |
| 2026-05-22 | transfer_fund |  | ₹35,00,000 | Amino SBI CC Account-44656290967 | 44959290204 NANDAMURI POULTRIESLLP |
| 2026-05-23 | transfer_fund | ₹55,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2305260001297/NAN DAMURI POULTRIESLLP |
| 2026-05-23 | transfer_fund |  | ₹50,00,000 | Amino SBI CC Account-44656290967 | CMPIFT/2305260001455/AMINO FARMS PRIVATE LIMITED |
| 2026-05-27 | transfer_fund | ₹1,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2605260018072/NAN DAMURI POULTRIESLLP |
| 2026-05-27 | transfer_fund |  | ₹1,60,80,011 | Amino SBI CC Account-44656290967 | FROMTRANSFER FROM 44916507220 |
| 2026-05-27 | transfer_fund | ₹20,00,000 |  | Amino SBI CC Account-44656290967 | TO TRANSFERCMPIFT/ 2705260112578 |
| 2026-05-30 | transfer_fund | ₹1,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/3005260036102/Nandamuri Poultries |
| 2026-06-08 | transfer_fund | ₹12,25,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0806260052049/NAN DAMURI POULTRIESLLP |
| 2026-06-13 | transfer_fund | ₹4,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1306260011337/NAN DAMURI POULTRIESLLP |
| 2026-06-15 | transfer_fund |  | ₹5,00,000 | Amino SBI CC Account-44656290967 | CMPIFT/1506260023396/AMINO FARMS PRIVATE LIMITED |
| 2026-06-16 | transfer_fund | ₹4,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1606260019314/NAN DAMURI POULTRIESLLP |
| 2026-06-17 | transfer_fund | ₹1,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1706260021737/NAN DAMURI POULTRIESLLP |
| 2026-06-26 | transfer_fund | ₹2,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2606260007832/NAN DAMURI POULTRIESLLP |
| 2026-06-30 | transfer_fund | ₹27,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/3006260041615/NAN DAMURI POULTRIESLLP |
| 2026-07-04 | transfer_fund | ₹10,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0407260053224/NAN DAMURI POULTRIESLLP |
| 2026-07-11 | transfer_fund | ₹7,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1107260025441/NAN DAMURI POULTRIESLLP |
| 2026-07-14 | transfer_fund | ₹3,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1407260001172/NAN DAMURI POULTRIESLLP |
| 2026-07-15 | transfer_fund | ₹33,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1507260004926/NAN DAMURI POULTRIESLLP |
| 2026-07-23 | transfer_fund | ₹7,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2307260006110/NAN DAMURI POULTRIESLLP |

### Investment in Luit Valley Farms LLP — 86 postings, net ₹9,02,15,001

| Date | Doc type | Dr | Cr | Paid through / offset | Narration |
|---|---|---:|---:|---|---|
| 2024-09-14 | expense | ₹15,044 |  | ICICI A/C - 058805501402 | LEI Registration 3 YEARS |
| 2024-09-30 | expense | ₹18,00,000 |  | ICICI A/C - 058805501402 | Investment — Investment |
| 2024-10-21 | expense | ₹61,84,957 |  | ICICI A/C - 058805501402 | Luit Vally Farms llp |
| 2025-02-24 | expense | ₹2,66,700 |  | Undeposited Funds | Dalmiya payment purpose |
| 2025-05-19 | transfer_fund | ₹30,00,000 |  | Amino SBI Current A/C-43311518227 |  |
| 2025-06-06 | transfer_fund | ₹50,00,000 |  | Amino SBI Current A/C-43311518227 |  |
| 2025-06-06 | transfer_fund | ₹5,00,000 |  | Amino SBI Current A/C-43311518227 |  |
| 2025-06-09 | transfer_fund | ₹5,00,000 |  | Amino SBI Current A/C-43311518227 |  |
| 2025-06-17 | transfer_fund | ₹5,00,000 |  | Amino SBI Current A/C-43311518227 | Transfer to Luit Valley Farm |
| 2025-06-24 | transfer_fund | ₹2,00,000 |  | Amino SBI Current A/C-43311518227 | Transfer to Luit Valley SBI Current Account |
| 2025-06-30 | transfer_fund | ₹2,00,000 |  | Amino SBI Current A/C-43311518227 | Luit Valley SBI Current Account |
| 2025-07-07 | transfer_fund | ₹50,000 |  | Amino SBI Current A/C-43311518227 | Luit Valley Sbi Current Account. |
| 2025-07-30 | transfer_fund | ₹5,00,000 |  | Amino SBI Current A/C-43311518227 | Transfer to LuitValley sbi current account |
| 2025-08-26 | transfer_fund | ₹14,00,000 |  | Amino SBI Current A/C-43311518227 | Luit Valley Sbi Current Account |
| 2025-08-29 | transfer_fund | ₹28,83,300 |  | Amino SBI Current A/C-43311518227 | Amount transfer to Luit Sbi current account |
| 2025-09-10 | transfer_fund | ₹15,00,000 |  | Amino SBI Current A/C-43311518227 | CMP000000012445210 LUIT VALLEY FARMS LLP |
| 2025-09-13 | transfer_fund | ₹2,00,000 |  | Amino SBI Current A/C-43311518227 | CMP000000012464790 - LUIT VALLEY FARMS LLP |
| 2025-09-17 | transfer_fund | ₹20,00,000 |  | Amino SBI Current A/C-43311518227 | CMP000000012481538 21AOYC243731 |
| 2025-09-23 | transfer_fund | ₹20,00,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001251221 46AOYE924987 |
| 2025-09-27 | transfer_fund | ₹3,00,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001256121324AOYH116042LUIT VALLEY FARMS |
| 2025-09-28 | transfer_fund | ₹50,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001256347729AOYH359106LUIT VALLEY FARMS |
| 2025-09-30 | transfer_fund | ₹5,00,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001266430115AOYJ153086LUIT VALLEY FARMS |
| 2025-10-01 | transfer_fund | ₹25,00,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001266702203AOYJ399516LUIT VALLEY FARMS |
| 2025-10-04 | transfer_fund | ₹40,00,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001268655899AOYL053770LUIT VALLEY FARMS |
| 2025-10-09 | transfer_fund | ₹40,00,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001272227943AOYO009048LUIT VALLEY FARMS |
| 2025-10-09 | transfer_fund | ₹30,00,000 |  | Amino SBI Current A/C-43311518227 | CMP00000001272221279AOYO005070LUIT VALLEY FARMS |
| 2025-10-31 | transfer_fund | ₹3,90,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0131102512831/LUIT VALLEY FARMS LLP |
| 2025-11-18 | transfer_fund | ₹20,00,000 |  | Amino SBI CC Account-44656290967 | transferd to Luit Valley sbi current account |
| 2025-12-01 | transfer_fund | ₹10,00,000 |  | Amino SBI CC Account-44656290967 | TRANSFER TO 43366336480 LUIT VALLEY FARMS LLP / |
| 2025-12-29 | transfer_fund | ₹6,50,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0129122552019/Luit Valley farm |
| 2026-01-12 | transfer_fund | ₹7,50,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0112012639448/Luit Valley Farms LLP |
| 2026-01-19 | transfer_fund | ₹5,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/011901263251/LUIT VALLEY FARMS LLP |
| 2026-01-28 | transfer_fund | ₹2,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/012801265951/LUIT VALLEY FARMS LLP |
| 2026-01-30 | transfer_fund | ₹2,50,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/3001260025473/LUIT VALLEY FARMS LLP |
| 2026-02-02 | transfer_fund | ₹1,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0202260006829/LUIT VALLEY FARMS LLP- |
| 2026-02-12 | transfer_fund | ₹22,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/1202260028673/Assa m- |
| 2026-02-23 | transfer_fund | ₹15,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/2302260002693/LUIT VALLEY FARMS LLP |
| 2026-02-23 | transfer_fund | ₹35,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2302260014624/LUIT VALLEY FARMS LLP |
| 2026-02-27 | transfer_fund | ₹7,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2702260047584/LUIT VALLEY FARMS LLP |
| 2026-02-28 | expense | ₹1,89,50,000 |  | Amino SBI Current A/C-43311518227 |  |
| 2026-03-05 | transfer_fund | ₹25,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0303260071487/LUIT VALLEY FARMS LLP |
| 2026-03-14 | transfer_fund | ₹1,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1403260016591/LUIT VALLEY FARMS LLP |
| 2026-03-17 | transfer_fund | ₹2,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1703260001792/LUIT VALLEY FARMS LLP |
| 2026-03-20 | transfer_fund | ₹5,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2003260003591/LUIT VALLEY FARMS LLP- |
| 2026-03-25 | transfer_fund | ₹50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2503260015777/Luit Valley Farm |
| 2026-03-30 | transfer_fund |  | ₹28,00,000 | Undeposited Funds | refund |
| 2026-03-31 | transfer_fund | ₹3,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/3103260065887/Luit Valley Farms- |
| 2026-04-10 | transfer_fund | ₹30,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1004260002728/LUIT VALLEY FARMS LLP |
| 2026-04-20 | transfer_fund | ₹3,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2004260014047/Luit Valley Farm- |
| 2026-04-22 | transfer_fund | ₹3,40,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/2204260015279/LUIT VALLEY FARMS LLP- |
| 2026-04-27 | transfer_fund | ₹25,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2704260010450/Luit Valley Farms |
| 2026-04-28 | transfer_fund |  | ₹40,00,000 | Amino SBI CC Account-44656290967 | 44959263622 LUIT VALLEY FARMS LLP |
| 2026-04-28 | transfer_fund | ₹25,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2804260015059/Luit Valley Farm LLP |
| 2026-04-30 | transfer_fund | ₹26,65,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/3004260065811/LUIT VALLEY FARMS LLP |
| 2026-05-02 | transfer_fund | ₹6,00,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0205260042287/LUIT VALLEY FARMS LLP- |
| 2026-05-05 | transfer_fund | ₹1,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0505260032288/LUIT VALLEY FARMS LLP |
| 2026-05-07 | transfer_fund | ₹5,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0705260087140/LUIT VALLEY FARMS LLP |
| 2026-05-09 | transfer_fund | ₹8,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0905260031419/LUIT VALLEY FARMS LLP |
| 2026-05-13 | transfer_fund | ₹1,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1305260024784/LUIT VALLEY FARMS LLP |
| 2026-05-19 | transfer_fund | ₹2,00,000 |  | Amino SBI CC Account-44656290967 | 1905260002393 |
| 2026-05-22 | transfer_fund | ₹50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2205260000934/LUIT VALLEY FARMS LLP |
| 2026-05-22 | transfer_fund |  | ₹20,00,000 | Amino SBI CC Account-44656290967 | 44959263622 LUIT VALLEY FARMS LLP |
| 2026-05-23 | transfer_fund | ₹40,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2305260001505/LUIT VALLEY FARMS LLP |
| 2026-05-27 | transfer_fund | ₹20,00,000 |  | Amino SBI CC Account-44656290967 | MPIFT/ 2705260112577/ |
| 2026-06-05 | transfer_fund | ₹15,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0506260015075/LUIT VALLEY FARMS LLP |
| 2026-06-06 | transfer_fund | ₹5,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0606260092024/LUIT VALLEY FARMS LLP |
| 2026-06-08 | transfer_fund | ₹1,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0806260052048/LUIT VALLEY FARMS LLP |
| 2026-06-10 | transfer_fund | ₹1,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1006260001554/LUIT VALLEY FARMS LLP |
| 2026-06-10 | transfer_fund | ₹2,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1006260025092/LUIT VALLEY FARMS LLP |
| 2026-06-11 | transfer_fund | ₹50,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/1006260066588/LUIT VALLEY FARMS LLP |
| 2026-06-11 | transfer_fund | ₹50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1106260034011/LUIT VALLEY FARMS LLP |
| 2026-06-13 | transfer_fund | ₹3,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1306260014107/LUIT VALLEY FARMS LLP |
| 2026-06-15 | transfer_fund |  | ₹12,00,000 | Amino SBI CC Account-44656290967 | CMPIFT/1506260023250/AMINO FARMS PRIVATE LIMITED |
| 2026-06-18 | transfer_fund | ₹6,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1806260019627/LUIT VALLEY FARMS LLP |
| 2026-06-23 | transfer_fund | ₹1,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2306260003098/LUIT VALLEY FARMS LLP |
| 2026-06-29 | transfer_fund | ₹3,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2906260010846/LUIT VALLEY FARMS LLP |
| 2026-06-30 | transfer_fund | ₹20,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/3006260018982/LUIT VALLEY FARMS LLP |
| 2026-06-30 | transfer_fund | ₹27,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/3006260041614/LUIT VALLEY FARMS LLP |
| 2026-07-03 | transfer_fund | ₹3,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0307260035811/LUIT VALLEY FARMS LLP |
| 2026-07-04 | transfer_fund | ₹50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/0407260053223/LUIT VALLEY FARMS LLP |
| 2026-07-06 | transfer_fund | ₹1,50,000 |  | Amino SBI Current A/C-43311518227 | CMPIFT/0607260028540/LUIT VALLEY FARMS LLP |
| 2026-07-11 | transfer_fund | ₹7,50,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1107260025440/LUIT VALLEY FARMS LLP |
| 2026-07-14 | transfer_fund | ₹2,20,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1407260001171/LUIT VALLEY FARMS LLP |
| 2026-07-15 | transfer_fund | ₹5,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/1507260004925/LUIT VALLEY FARMS LLP |
| 2026-07-20 | transfer_fund | ₹2,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2007260011503/LUIT VALLEY FARMS LLP |
| 2026-07-23 | transfer_fund | ₹1,00,000 |  | Amino SBI CC Account-44656290967 | CMPIFT/2307260006109/LUIT VALLEY FARMS LLP |

## C. Capital spend entered through the Expense module (not a bill)

| Capital account | Count | Amount |
|---|---:|---:|
| Investment in Luit Valley Farms LLP | 5 | ₹2,72,16,701 |
| Investment in Nandammuri Poultries LLP | 4 | ₹1,15,00,001 |
| Electrical Installation | 3 | ₹20,16,779 |
| Poultry Sheds | 215 | ₹9,36,153 |
| Land & Land Development | 10 | ₹8,72,539 |
| Poultry Cages & Equipment | 6 | ₹4,65,496 |
| Office Equipment | 7 | ₹47,886 |
| Buildings (Office & Staff) | 3 | ₹24,581 |
| Furniture & Fixtures | 9 | ₹18,687 |
| Mobile & Computer Equipment | 2 | ₹7,449 |
| Composting Equipment | 2 | ₹5,351 |
| **Total** | **266** | **₹4,31,11,623** |

### Land & Land Development — 10 expense txns, ₹8,72,539

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2024-07-15 | ₹7,000 | ICICI A/C - 058805501402 | 241-Land Demarketio/SailendraN | Land Demarketio/SailendraN,Posts for Land Boundery Merking 50pcs |
| 2024-08-27 | ₹2,38,463 | ICICI A/C - 058805501402 | Revenue dept/GoshaiBisw |  |
| 2024-08-28 | ₹1,48,113 | ICICI A/C - 058805501402 | Land Registration charges |  |
| 2024-08-28 | ₹3,150 | Cash | C.V No:11 Tulshi Devi | Registation Fees for Tulshi Devi Land Purchase Ref-Rohan Sir |
| 2024-08-28 | ₹43,600 | Cash | C.V No;12 Pradeep Bhandari | Registation Fees for Pradeep Bhandari Land Purchase Ref-Rohan Sir |
| 2024-08-28 | ₹43,600 | Cash | C.V No:13 AM Prasad | Registation Fees for AM Prasad Land Purchase Ref-Rohan Sir |
| 2025-03-17 | ₹71,622 | ICICI A/C - 058805501402 | Land Conversion Premium (Agricultural to Industria | 000984980925/UBPS/594266285 BIL/ONL/000984980925/Directorat/Recl Premium WORLDLINE EPAYM |
| 2025-03-17 | ₹71,622 | ICICI A/C - 058805501402 | Land Conversion Premium (Agricultural to Industria | 000985009190/UBPS/594266285 BIL/ONL/000985009190/Directorat/Recl Premium WORLDLINE EPAYM |
| 2025-03-17 | ₹2,43,329 | ICICI A/C - 058805501402 | Land Conversion Premium (Agricultural to Industria | Land Conversion Premium (Agricultural to Industrials 000985012057/UBPS/594266285 BIL/ONL/000985012057/Director |
| 2025-03-19 | ₹2,040 | ICICI A/C - 058805501402 | NOC Reclassification Government | NOC Reclassification Government 507855201829//9229001008805501 UPI/507855201829/ReclAppFee/governmentsp@ba//IC |

### Investment in Luit Valley Farms LLP — 5 expense txns, ₹2,72,16,701

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2024-09-14 | ₹15,044 | ICICI A/C - 058805501402 | LEI Registration 3 YEARS |  |
| 2024-09-30 | ₹18,00,000 | ICICI A/C - 058805501402 | Investment | Investment |
| 2024-10-21 | ₹61,84,957 | ICICI A/C - 058805501402 | Luit Vally Farms llp |  |
| 2025-02-24 | ₹2,66,700 | Undeposited Funds | Dalmiya payment purpose |  |
| 2026-02-28 | ₹1,89,50,000 | Amino SBI Current A/C-43311518227 |  |  |

### Investment in Nandammuri Poultries LLP — 4 expense txns, ₹1,15,00,001

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2024-09-14 | ₹15,044 | ICICI A/C - 058805501402 | LEI Registration 3 YEARS |  |
| 2024-09-30 | ₹18,00,000 | ICICI A/C - 058805501402 | Investment | Investment |
| 2024-10-21 | ₹61,84,957 | ICICI A/C - 058805501402 | Nandamuri Poultries LLP |  |
| 2025-05-19 | ₹35,00,000 | Amino SBI Current A/C-43311518227 | INVEST IN NANDAMURI POultries | INVEST IN NANDAMURI POultries |

### Poultry Sheds — 215 expense txns, ₹9,36,153

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2024-09-23 | ₹4,000 | ICICI A/C - 058805501402 | Invoice No-1918163 Creta - 3333 | Creta Fuel VPS/SHEW PRASAD/202409231148/426706304902/GUWAHATI |
| 2024-10-01 | ₹4,000 | ICICI A/C - 058805501402 | Invoice No-000028 Creta - 3333 | IPS/Kuljit Sing/202410011938/000000000033/TEZPUR |
| 2024-10-06 | ₹4,000 | ICICI A/C - 058805501402 | Creta Petrol Creta - 3333 | Creta Petrol |
| 2024-10-09 | ₹4,000 | ICICI A/C - 058805501402 | Creta Petrol-857582 Creta - 3333 | Creta Petrol VPS/SREE AMBA S/202410091819/428312245170/NAGAON |
| 2024-10-10 | ₹5,500 | ICICI A/C - 058805501402 | Sand | Sand for Site Work |
| 2024-10-10 | ₹20,000 | ICICI A/C - 058805501402 | Pooja Food | advance Pooja Food |
| 2024-10-12 | ₹2,000 | Cash | C.V No:27,Invoice No:2219 WagonR - 3988 | Rupam Petroleum Co Cash Paid for Wagonr-3988 Petrol (Rohan sir ) |
| 2024-10-16 | ₹4,500 | ICICI A/C - 058805501402 | Cretafuel Creta - 3333 |  |
| 2024-10-19 | ₹3,000 | Cash | C.V No:31,Invoice No:J1038 WagonR - 3988 | Indian Oil Cash Pait To Rohan Sir for Wagonr-3988 Petrol |
| 2024-10-22 | ₹4,000 | ICICI A/C - 058805501402 | Creta DAWNLIT/ Creta - 3333 | Creta Petrol Creta - 3333 |
| 2024-10-23 | ₹2,890 | Cash | C.V No:34,Invoice No:319917 WagonR - 0287 | Nayara Petrol Pump Cash Paid to Petrol Pump for Wagonr-0287 |
| 2024-10-23 | ₹4,000 | ICICI A/C - 058805501402 | Creta Petrol-3333 | Creta Petrol |
| 2024-10-24 | ₹22,000 | ICICI A/C - 058805501402 | Pooja Lunch Expenses | MMT/IMPS/429814586486/Staff welfare/SanketSara/UTI B0000596 |
| 2024-10-27 | ₹4,000 | ICICI A/C - 058805501402 | Creta - 3333 | IPS/Kuljit Sing/202410272053/000000000343/TEZPUR |
| 2024-10-30 | ₹1,830 | ICICI A/C - 058805501402 | Transportation/SaifulRahaman40 | UPI/430459931455/transportation/saifulrahaman40//I CI7adc05bcad7343ddbe0233bf8e6c48c8/ |
| 2024-11-01 | ₹8,590 | ICICI A/C - 058805501402 | 430637627656//9229001008805501 | UPI/430637627656/Oid6EJFTMA01BC2/paytm-43409491@/Y es Bank Ltd/PTM41101804150968175617202411010306/ |
| 2024-11-02 | ₹4,500 | ICICI A/C - 058805501402 | Cretafuel-3333 | UPI/430776208398/cretafuel/bd591788@okicic//ICIea3 3aabb086c4d72a3613b5fffbd25cc/ |
| 2024-11-02 | ₹3,000 | Cash | C.V No:39,Invoice No:K0376 scooty-0287 | Indian Oil Cash Paid to Petrol for Subhash Sir scooty-0287 |
| 2024-11-04 | ₹430 | Cash | C.V No:166,401-Ramkrishna Hardware | Cash Paid to Ramkrishna Hardware |
| 2024-11-06 | ₹4,000 | ICICI A/C - 058805501402 | 756299 Creta - 3333 | Creta Fuel-AS12AL3333 UPI/431195890893/Cretafuel/paytmqr28100505//ICI1df a351747e94e43a602cae90c1abb18/ |
| 2024-11-11 | ₹15,000 | ICICI A/C - 058805501402 | Advance for Container Freight | UPI/431619763221/containerfreigh/dhruba784125@ok// ICI6b93f7a9dcda4b51a06518f94039d4f9/ |
| 2024-11-11 | ₹2,840 | ICICI A/C - 058805501402 | Anudiv Ener WagonR - 3988 | IPS/ANUDIV ENER/202411110947/000000004938/SONITPUR |
| 2024-11-13 | ₹9,400 | ICICI A/C - 058805501402 | Containertransp/dhruba | UPI/431829540760/containertransp/dhruba784125@ok// ICIa6c026400acb49a3a3cc2d6ecadbf509/ |
| 2024-11-13 | ₹4,000 | ICICI A/C - 058805501402 | 367421-Tumuki Filling Petrol Creta - 3333 | Tumuki Filling Petrol IPS/TUMUKI FILL/202411131354/000000003481/SONITPUR |
| 2024-11-14 | ₹830 | Cash | C.V No:53,Invoice No:2305 | Rukhsana Hardware Cash Paid to Rukhsana Hardware for Lock Key/Door Lock |
| 2024-11-15 | ₹3,500 | Cash | C.V No:55,Invoice No:5443 HSD - Site | M/S Sonitpur Service Station Cash Paid to Biki Da for Site Generator Use Petrol (1500+2000=3500/-) |
| 2024-11-16 | ₹5,000 | ICICI A/C - 058805501402 | Sheds Purpose -50 Pcs Bhaluka Bamboo | 50 Pcs Bhaluka Bamboo |
| 2024-11-16 | ₹394 | Cash | C.V No:60,Invoice No:3750 | M/S Timsina Hardware Cash Paid for Office Expenses(net) |
| 2024-11-16 | ₹2,500 | ICICI A/C - 058805501402 | Wagnor Petrol WagonR - 0287 | IPS/MS N R L EN/202411161015/000000012764/TEZPUR |
| 2024-11-17 | ₹3,000 | Cash | C.V No:61,Invoice No:1957427 Creta - 3333 | Shew Prasad & Sons Cash Paid To Petrol For Creta Car-3333(Shew Prasad & Sons) |
| 2024-11-18 | ₹3,500 | ICICI A/C - 058805501402 | Generator | Petrol Purchase for Used Generator at Site |
| 2024-11-19 | ₹5,500 | ICICI A/C - 058805501402 | 002077 Creta - 3333 | 2500/-Generator Petrol For Site Use , 3000/-Petrol For Creta Car. |
| 2024-11-20 | ₹3,624 | ICICI A/C - 058805501402 | Grocery For Office Staff Lunch Welfare Use | Grocery For Office Staff Lunch Welfare Use |
| 2024-11-22 | ₹10,000 | ICICI A/C - 058805501402 | Road Roller Rent | Road Roller Rent UPI/432771664484/rollerrent/8876036677@axl//ICId30 3c313423240d7a010e15f73de6e0b/ |
| 2024-11-22 | ₹4,522 | ICICI A/C - 058805501402 | K2638 Creta - 3333 | Creta Fuel -AS12AL3333 UPI/432770598601/cretafuel/q542395226@ybl//ICI89f8 7708e90f40b0b5aa7e5b72594296/ |
| 2024-11-23 | ₹7,500 | ICICI A/C - 058805501402 | Site For Labours Blankets | site for labours blankets (UPI/432876274533/siteblankets/royr41395@oksbi//ICI ee9b2dee851144ffaf464da9d7ba3b7a |
| 2024-11-23 | ₹3,500 | ICICI A/C - 058805501402 | K6590 WagonR - 0287 | Wagonr Petrol-0287 gensetpetrol |
| 2024-11-23 | ₹3,000 | ICICI A/C - 058805501402 | Petrol for Wagonr car WagonR - 3988 | Petrol for Wagonr car (Rohan Sir ) |
| 2024-11-24 | ₹3,678 | ICICI A/C - 058805501402 | GensetPetrol | Site for Gensetpetrol (UPI/432979050284/sitegensetpetro/q903930273@ybl//I CI14be6df53ed845bca8a668e80db3fa36/) |
| 2024-11-26 | ₹2,740 | ICICI A/C - 058805501402 | P6223RES25005790(LUNCH) | Lunch Rohan Sir Hari Sir. |
| 2024-11-26 | ₹4,000 | ICICI A/C - 058805501402 | 002125/423911(Creta Petrol) Creta - 3333 | Creta Petrol -3333 |
| 2024-11-28 | ₹3,400 | ICICI A/C - 058805501402 | K2907,Office WagonR - 0287 | K2907,Office Wagonr-AS01DE0287 UPI/433398485441/office wagoner /q954416361@ybl//ICI8 5245bdb216448e6b5eb598943 |
| 2024-11-29 | ₹4,500 | ICICI A/C - 058805501402 | Creta Petrol Creta - 3333 | UPI/433403911265/cretapetrol/q642019138@ybl//ICIed c51cc96901408c9b4b08061c7a55b3/ |
| 2024-11-30 | ₹2,200 | Amino SBI Current A/C-43311518227 | Sanu Hasda Murmu | Sanu Hasda Murmu,Daily Cleaning Wages (11 days) |
| 2024-12-02 | ₹24,000 | ICICI A/C - 058805501402 | CablesTransport/vyapar | UPI/433718528768/cablestransport/vyapar.17140736// ICI58736b1f2a3942a393fce2003c6b59e7/ 433718528768//92290010 |
| 2024-12-02 | ₹2,695 | ICICI A/C - 058805501402 | Universl Boss Multi Cuisine Restaurant | Universl Boss Multi Cuisine Restaurant SBI Officeals Lunch. UPI/433718689094/lunch/gpay-1124221278//ICI6191e4b |
| 2024-12-02 | ₹3,000 | ICICI A/C - 058805501402 | 426529 -GenserPetrol | UPI/433718107017/genserpetrol/q903930273@ybl//ICI3 dc2ca67d89e45b1b8acdac02f778527/ GenserPetrol for Site |
| 2024-12-03 | ₹4,058 | ICICI A/C - 058805501402 | OfficeGroceries | 433824726688//9229001008805501 UPI/433824726688/officegroceries/subhash.sapkota// ICIc66c97080ec14331a6e8fcfc8 |
| 2024-12-03 | ₹8,550 | ICICI A/C - 058805501402 | 4253-Universal Boss Multi Cuisine Restaurant | Amino Officer Lunch For Universal Boss Multi Cuisine Restaurant433823987123//9229001008805501 UPI/433823987123 |
| 2024-12-03 | ₹4,700 | ICICI A/C - 058805501402 | CretaFuel Creta - 3333 | 433822013751//9229001008805501 UPI/433822013751/cretafuel/q340036943@ybl//ICIbd29 82477f11438d8e31f05fe94bd7d4 |
| 2024-12-03 | ₹2,880 | ICICI A/C - 058805501402 | OfficeWagonr WagonR - 0287 | OfficeWagonrFuel AS01DE0287 433822181749//9229001008805501 UPI/433822181749/officewagonrfue/getepay.ucbqrap//  |
| 2024-12-04 | ₹3,500 | ICICI A/C - 058805501402 | Wagonr Petrol-3988 | 433927518442//9229001008805501 UPI/433927518442/3988fuel/q809669558@ybl//ICIa3ccb 76e3df748b98b3fd5e34fe1af44/ |
| 2024-12-05 | ₹3,000 | ICICI A/C - 058805501402 | GenSetPetrol | 434035521204//9229001008805501 UPI/434035521204/genaetpetrol/q903930273@ybl//ICI0 2993abe010a4e8993c6f41ae56ff |
| 2024-12-05 | ₹4,700 | ICICI A/C - 058805501402 | L557-Creta Petrol Creta - 3333 | Creta Petrol 0302/291918/4689570588016214 IPS/DRIDHA AGRI/202412052212/000000000302/TEZPUR |
| 2024-12-07 | ₹100 | Cash | C.V No:88,Tarminator @2Pcs | Cash Paid to Tarminator @2Pcs for JCB Battery Ref-Pranav Sir |
| 2024-12-07 | ₹3,100 | ICICI A/C - 058805501402 | Office WagonrPetrol-0287 | 434246094981//9229001008805501 UPI/434246094981/officewagonrfue/q909438595@ybl//I CI3b53753cdba444c4872ea6cda9 |
| 2024-12-10 | ₹3,000 | ICICI A/C - 058805501402 | site cylinder | UPI/434561596994/sitecylinder/q570252450@ybl//ICIf 240bd43fd98435d87f1b673ef60a1c8/ |
| 2024-12-10 | ₹2,881 | ICICI A/C - 058805501402 | 004524 WagonR - 3988 | Wagonr Petrol-3988-Rohan Saraf |
| 2024-12-10 | ₹3,000 | ICICI A/C - 058805501402 | 430042 Petrol - Genset | Petrol for Site Generator Use |
| 2024-12-12 | ₹3,400 | ICICI A/C - 058805501402 | Wagonr Petrol-0287 | Wagonr Petrol-0287 Ref Subhash Sir 434773307197//9229001008805501 UPI/434773307197/OfficeWagonRFue/getepay.ucb |
| 2024-12-13 | ₹4,500 | ICICI A/C - 058805501402 | CretaFuel-3333 | UPI/434876238414/CretaFuel/q247059502@ybl//ICIa2e1 752076244f449e72fb41c830f342/ |
| 2024-12-13 | ₹3,000 | ICICI A/C - 058805501402 | Site Generator Fuel | UPI/434876315889/SiteGeneratorFu/q909438595@ybl//I CI41782fee015d485e8c56c34859fab35c/ |
| 2024-12-13 | ₹3,000 | ICICI A/C - 058805501402 | Site Genset Fuel | UPI/434876310238/SiteGeneratorFu/q909438595@ybl//I CIbfe1027b22b94d30bcd55f8a58ff4a8c/ |
| 2024-12-15 | ₹3,583 | ICICI A/C - 058805501402 | Office Grocery Expense | 435086019638//9229001008805501 UPI/435086019638/OfficeExpense/bharatpe.900710//IC Ie7e695b20cca4e6b9f3aab6e6e6 |
| 2024-12-16 | ₹70 | Cash | C.V No:99,Namila Hardware-13 | Cash Paid to Rajeev for Check Valve for Site Pump Ref-Pranav Sir |
| 2024-12-16 | ₹2,900 | ICICI A/C - 058805501402 | Wagonr Petrol-3988 | Wagonr Petrol-3988435188925975//9229001008805501 UPI/435188925975/WagonR3988Fuel/getepay.ucbqrap//I CI66960e51 |
| 2024-12-17 | ₹4,500 | ICICI A/C - 058805501402 | CretaPetrol-3333 | CretaPetrol-3333435295441779//9229001008805501 UPI/435295441779/CretaFuel/q705454363@ybl//ICIe9cc 8aa44f074309 |
| 2024-12-19 | ₹3,300 | ICICI A/C - 058805501402 | UPI/435404096837/Fuel WagonR - 0287 | UPI/435404085099/FuelWagonR0287/getepay.ucbqrap//I CI10ca61d590df4e84acea567f423dbdb7/ 435404096837//922900100 |
| 2024-12-19 | ₹3,300 | ICICI A/C - 058805501402 | UPI/435404085099/Fuel WagonR - 0287 | Wagonr Petrol-0287 435404085099//9229001008805501 UPI/435404085099/FuelWagonR0287/getepay.ucbqrap//I CI10ca61d |
| 2024-12-20 | ₹3,000 | ICICI A/C - 058805501402 | UPI/435511626913/ WagonR - 3988 | UPI/435511626913/WagonRFuel/q809669558@ybl//ICI520 6331613424552930c329eb1a54e3c/ |
| 2024-12-20 | ₹3,000 | Cash | C.V No:104,Invoice No:458001-Fuel Exter-3088 | Ref-Rohan Sir Exter - 3088 |
| 2024-12-20 | ₹3,000 | ICICI A/C - 058805501402 | Exter Petrol -3088 | UPI/435509339866/Fuel/q809669558@ybl//ICIb9e9c37ad 44c4e75b551986f0c681e8c/ Ref-Rohan Sir |
| 2024-12-22 | ₹4,501 | ICICI A/C - 058805501402 | Creta Petrol-3333 | 435718394441//9229001008805501 UPI/435718394441/CretaFuel/q840776183@ybl//ICIc769 7f05085c4ded9db48d2274817ba7 |
| 2024-12-23 | ₹5,872 | ICICI A/C - 058805501402 | Hotel Accommodations Directors | 435830863124//9229001008805501 UPI/435830863124/Oid2163123162Ag/paytm-52649125@/Y ES BANK LIMITE/PTM4122380449 |
| 2024-12-24 | ₹4,200 | ICICI A/C - 058805501402 | CretaFuel-3333 | 435929917864//9229001008805501 UPI/435929917864/CretaFuel/q108784221@ybl//ICI320d cb1838564e0580ef3453c5fc40bd |
| 2024-12-25 | ₹11,000 | ICICI A/C - 058805501402 | Drum for Site Water and Oil Stores | 436034016632//9229001008805501 UPI/436034016632/EmptyDrum/gpay-1123538330//ICI4fc 512225a8a4628b4733449b111647 |
| 2024-12-25 | ₹120 | Cash | C.V NO:110,L.K Enterprise-1269 | Cash Paid to Rohan Sir for Rasi Purchase Ref-Rohan Sir |
| 2024-12-25 | ₹8,500 | ICICI A/C - 058805501402 | Mobil Engine Oil for Site Shuttering Use | 436034287939//9229001008805501 UPI/436034287939/MobilForShutter/gurdeept2@okhdf// ICI8f82671bd20a43d69430d765d |
| 2024-12-26 | ₹3,945 | ICICI A/C - 058805501402 | GeneratorPetrol | Petrol for Site Generator 436138523207//9229001008805501 UPI/436138523207/GeneratorPetrol/q909438595@ybl//I CI |
| 2024-12-29 | ₹320 | Cash | C.V No:111,M/s Saikia Store | Cash Paid to Rohan Sir for 2mm Not Purchase Ref-Rohan Sir |
| 2024-12-30 | ₹3,500 | Amino SBI Current A/C-43311518227 | Installation | Being AMount Payable to Hanif Ali towwards Boring & Pump Installation - 2 Nos in site purpose. |
| 2025-01-02 | ₹200 | Cash | C.V NO:113Paul Store-1299 | Ref-Rajib Bhaiya Cash Paid to Rajeev Pukharel Bhaiya for Site Security Register Book Purchase |
| 2025-01-02 | ₹3,000 | ICICI A/C - 058805501402 | A0036-Creta Petrol-3333 | Creta Petrol-3333 500270375160//9229001008805501 UPI/500270375160/Creta3333/q464658373@ybl//ICI2c33 b35956a940 |
| 2025-01-02 | ₹3,450 | ICICI A/C - 058805501402 | A1050-Wagonr Petrol-0287 | Wagonr Petrol-0287 500270539481//9229001008805501 UPI/500270539481/WagonR0287/getepay.ucbqrap//ICI9d e4cc18ee3 |
| 2025-01-02 | ₹2,500 | ICICI A/C - 058805501402 | Wagonr Petrol-3988 | 500273650757//9229001008805501 UPI/500273650757/WagonR3688/getepay.ucbqrap//ICIf9 e788201dd048398c31f39e73bf86 |
| 2025-01-03 | ₹3,718 | ICICI A/C - 058805501402 | Vegetables Items Purchase for Thelamara Office | Vegetables Items Purchase for Thelamara Office S2723966 UPI/500377629492 /OfficeExpenses/gp ay-1125143309//I |
| 2025-01-06 | ₹785 | ICICI A/C - 058805501402 | HardwareItems for Site | HardwareItems for Site Ref-Rajiv 500694572483//9229001008805501 UPI/500694572483/HardwareItems/getepay.mbandha |
| 2025-01-06 | ₹1,920 | Cash | C.V No:118,S.A. Electrical Works-13 | Cash Paid to Rohan Sir for Carbon,Bushing,Labour Service Charge for Fitting,Soldering Ref-Rohan Sir |
| 2025-01-06 | ₹100 | Cash | C.V No:117,Ref-Pranav/ Rajib | Cash Paid to Rajib Pokhrel for Water Can 2Pcs@50=100/- |
| 2025-01-07 | ₹10,000 | ICICI A/C - 058805501402 | LabourBlankets | 500799326080//9229001008805501 UPI/500799326080/LabourBlankets/9911707601zulfe//I CI50e5169194164d5da08a346092 |
| 2025-01-09 | ₹80 | Cash | C.V No:124,Om Shree Hardware | Cash Paid for Solvent , Mseal etc Pranav Sir |
| 2025-01-09 | ₹310 | Cash | C.V No:125,G.K Hardware-102 | Cash Paid to G.K Hardware for Bucket Brush Ref-GVR Sir |
| 2025-01-09 | ₹2,100 | Cash | C.V No:126,Ref-Subhash Sir | Cash Paid to Dalmia Cement unloading Labour Cost Charges |
| 2025-01-11 | ₹2,000 | Cash | C.V No:132,Ref-Pranav Sir | Cash Paid Old Faulkner Driver |
| 2025-01-11 | ₹3,000 | Cash | C.V No:133,Ref-Pranav Sir | Cash Paid New Faulkner Driver,Date-11,12,13,14,15,16,17-Jan-2025 |
| 2025-01-11 | ₹1,600 | Cash | C.V No:134,Ref-Pranav/ Rajib | Concrate Mixture Machine Delivery Charges |
| 2025-01-13 | ₹2,100 | ICICI A/C - 058805501402 | LabourWages/bika shnath | S3043063UPI/501329866776 /LabourWages/bika shnath709je//ICI7 |
| 2025-01-14 | ₹9,915 | ICICI A/C - 058805501402 | Amazon | Site Expenses OfficeExpenses Vehicle Maintanance All Metarial Buy From Amazon Measuring Tape,Safety Shoes,Prin |
| 2025-01-16 | ₹2,100 | Cash | C.V No:142,Ref-Rohan Sir | Cash Paid to Dalmia Cement unloading Labour Cost Charges |
| 2025-01-17 | ₹2,990 | ICICI A/C - 058805501402 | Purchase Tiffin Boxes for Amazon | 501761692953//9229001008805501 UPI/501761692953/Youarepayingfor/amazon@rapl/Amazo n RBL/RBA0194734bf5b1bdbfe16 |
| 2025-01-17 | ₹1,600 | Cash | C.V No:146,Cash Paid 5Kg Gass | Cash Paid 5Kg Gass GVR Sir |
| 2025-01-20 | ₹22,235 | Amino SBI Current A/C-43311518227 | Office Groceries (Smart Bazaar)-6 | Office Groceries (Smart Bazaar) Ref-Pranav Sir |
| 2025-01-20 | ₹1,000 | Cash | C.V No;155,Ref-Pranav Sir/Rajib Bhaiya | Cash Paid to Rajib Phukrel Da for Plumber For repair of tullu pump and motor shifting |
| 2025-01-20 | ₹3,000 | Cash | C.V No:156,Ref-Rajib Bhaiya/GVR Sir | Cash Paid to New Faulkner Driver ,Date-18,19,20,21,22,23-Jan-2025 |
| 2025-01-21 | ₹2,100 | Cash | C.V No:157,Ref-Rohan sir | Cash Paid to Dalmia Cement unloading Labour Cost Charges |
| 2025-01-23 | ₹2,900 | ICICI A/C - 058805501402 | Poonam Auto Agency-7356 | HardwareGreese for Site 502376522545//9229001008805501 UPI/502376522545/HardwareGreese/eazypay.2000030//I CI7b |
| 2025-01-23 | ₹60 | Cash | C.V No:165,Akash Hardware | Cash Paid While Cutter Purchase Biki Da |
| 2025-01-24 | ₹2,000 | ICICI A/C - 058805501402 | Purchase Nut Bolt for Site | Nut Bolt for Site Colum Boxes 502481237178//9229001008805501 UPI/502481237178/HardwareNutBolt/basantagarwala7/ |
| 2025-01-24 | ₹1,240 | ICICI A/C - 058805501402 | Plants Purchase for Site | 502480983479//9229001008805501 UPI/502480983479/plants/q098857448@ybl//ICIec69903 7978349c48b2cf5f905561313/ |
| 2025-01-24 | ₹2,251 | ICICI A/C - 058805501402 | Purchase Biscuts for Site Office | 502482149741//9229001008805501 UPI/502482149741/OfficeExp/getepay.ucbqrap//ICI894 42a2e52384ed189bc67ca276d3bb |
| 2025-01-27 | ₹205 | Cash | C.V No:264,Invoice NoPMM/5741/24-25 | Cash Paid to Subhash Sir for Pawan Motor for Purchase Ball Valve UPS 25mm for Site Use |
| 2025-01-27 | ₹6,500 | Cash | C.V No:256,Boring Unload Labour Wages | Cash Paid to Rohan Sir for Boring Unload Labour Wages Ref-Rohan Sir |
| 2025-01-27 | ₹3,500 | Cash | C.V No:259,Tiles Fitting Office Labour Wages. | Cash Paid to Rohan Sir for Tiles Fitting Office Labour Wages. |
| 2025-01-27 | ₹4,550 | Cash | C.V No:261,Labour Payments for TMT Work | Cash Paid to Rohan Sir for Labour Payments for TMT Work i.e Date :21,22,23,24,25-1-25 Per Labour Wages@350/- T |
| 2025-01-27 | ₹2,500 | Cash | C.V No:258,Fouklen Driver Daily Work Allowance | Cash Paid to Rohan Sir for Fouklen Driver Daily Work Allowance i.e Date:24,25,26,27,28-1-2025. |
| 2025-01-27 | ₹5,500 | Cash | C.V No:262,UttamDasSecurity,Labour Room. | Cash Paid to Rohan Sir for Uttam Das Security and Store Room and Labour Room. |
| 2025-01-27 | ₹2,100 | Cash | C.V No:254,Dalmia Cement Unloading Charges | Cash Paid to Kunti ALI Labour for Dalmia Cement Unloading Charges |
| 2025-01-27 | ₹4,900 | ICICI A/C - 058805501402 | TransportCharge | S3945284 UPI/502794404166 /TransportCharge/t cifreight@hdfc// |
| 2025-01-27 | ₹1,200 | Cash | C.V No:257,2HP Motor,Cables transportation Wages | Cash Paid to Rohan Sir for 2HP Motor,Cables transportation Wages(TCI Tezpur to Thelamara) |
| 2025-01-28 | ₹2,570 | Cash | C.V No:269,Invoice No255,Grocery Items Purchase. | Cash Paid to Sandip Bhaiya for Thelamara Office ,Grocery Items Purchase. |
| 2025-01-30 | ₹1,620 | Cash | C.V No:270,Site Drinking Water Daily Purchase | Cash Paid to Rajib Bhaiya for Site Drinking Water Daily Purchase Date-18-1-25 to 27-1-25 ,three Can Purchase@2 |
| 2025-01-30 | ₹3,000 | Cash | C.V No:272,Site Plumber New Bathroom Working | Cash Paid to Rafikul Islam for Site Plumber New Bathroom Working Payment |
| 2025-02-01 | ₹13,300 | ICICI A/C - 058805501402 | DailyLabour/mrx91964- | 503220602820//9229001008805501 UPI/503220602820/DailyLabour/mrx91964-1@oksb//ICI1 bc8ce3d6a0244fc9fef5da73a8b6 |
| 2025-02-01 | ₹1,900 | Cash | C.V No:277, Disposals, Tea, Biscuts, etc. | Cash Paid to Rajib Da for Disposals,Chock Pencil, Tea, Biscuts, and Generator Meterial Transportation Freight  |
| 2025-02-01 | ₹2,000 | Cash | C.V No:278,Faulkner Driver Allowance | Cash Paid Rajiv Da for Faulkner Driver Allowance i.e Date-29,30,31,1-2-2025 Rajib Da/Pranav Sir |
| 2025-02-04 | ₹2,100 | ICICI A/C - 058805501402 | CementLabour | UPI/503533371177/CementLabour/9508582819@ybl//ICIb ad4bafdf39d4befb1ba88532ecf60ca/ |
| 2025-02-08 | ₹1,500 | Amino SBI Current A/C-43311518227 |  | Carpenter Charges - 2 Featherlite Almirah Fitting |
| 2025-02-13 | ₹8,030 | ICICI A/C - 058805501402 | OfficeGrocery | UPI/504479675725/OfficeGrocery/gpay-1124434711//IC I0161db648b52485d89fdd479ba081267/ |
| 2025-02-13 | ₹8,050 | ICICI A/C - 058805501402 | LabourWagesFeb7 | UPI/504480190581/LabourWagesFeb7/9394495683-2@ib// ICIfc1c1086da92494fbeebb7cb6e199650/ |
| 2025-02-16 | ₹2,100 | ICICI A/C - 058805501402 | CementLabourCharges | UPI/504795438141/CementLabourCha/arifahmedarif17// ICI91698fa917654ab89475f5314a2fa93b/ |
| 2025-02-16 | ₹5,100 | ICICI A/C - 058805501402 | TMTLabourCharges | UPI/504795445926/TMTLabourCharge/arifahmedarif17// ICI141b18a3e0254a92a1897fdfd0756a2a/ |
| 2025-02-18 | ₹1,400 | ICICI A/C - 058805501402 | LabourFirewood | 504904410863//9229001008805501 UPI/504904410863/LabourFirewood/9008107309@ybl//IC I7e37b4a6b4e04134918e4af7b13 |
| 2025-02-20 | ₹3,250 | Cash | C.V No:285,JCB Operator Diet Allowance | Cash Paid By Pranav Sir for JCB Operator 10-Feb to 22-Feb-25 Diet Allowance |
| 2025-02-22 | ₹1,250 | Cash | C.V No:292,bill No246,000193 | Cash Paid By Pranav Sir for Site Expense Ref-Rajiv Bhaiya |
| 2025-02-25 | ₹1,000 | Cash | C.V No:295,JCB Operator Diet Allowance | Cash Paid By Pranav Sir for Rajib Bhaiya for Site JCB Operator Diet Allowance 250x4Days Ref-Pranav Sir |
| 2025-02-28 | ₹9,875 | ICICI A/C - 058805501402 | OfficeGrocery | Thelamara Office Grocery purchase 505953604690//9229001008805501 UPI/505953604690/OfficeGrocery/gpay-112443471 |
| 2025-02-28 | ₹5,000 | Cash | Site and Office Expense(Cash Recd) GVR Sir | Cash Paid to GVR Sir for Site and Office Expense(Cash Recd) Ref-GVR Sir/Rohan Sir |
| 2025-02-28 | ₹5,770 | Cash | C.V No:298, GVR Sir for Site Expense | 1.Cash Paid by GVR Sir for Site Expense(Water Purchase 14Blt@50/-=700,ParataRef-Sandip=200/-, Hardware Items P |
| 2025-03-01 | ₹6,500 | ICICI A/C - 058805501402 | HydraRenta | HydraRenta |
| 2025-03-01 | ₹4,000 | Cash | Dalmia Cement Unloading Labour Charges | Cash Paid to Pranav Sir for Dalmia Cement Unloading Labour Charges Ref-Pranav sir/Rohan sir |
| 2025-03-01 | ₹5,100 | ICICI A/C - 058805501402 | DailyLabour | DailyLabour |
| 2025-03-01 | ₹2,000 | Cash | C.V No:301,Generator Transportation Site Expense | Cash Paid to Tanmay Nath,Rajib Bhaiya Ref-Pranav Sir for Generator Transportation from Tezpur for Site Expense |
| 2025-03-02 | ₹5,400 | ICICI A/C - 058805501402 | CementTMTLabour | CementTMTLabour |
| 2025-03-03 | ₹5,875 | ICICI A/C - 058805501402 | MS/T18717/24-25/Biscuit/mahadevstore | /Biscuit/mahadevstore |
| 2025-03-03 | ₹1,200 | ICICI A/C - 058805501402 | Transportation Charges | Transportation Charges |
| 2025-03-04 | ₹5,000 | ICICI A/C - 058805501402 | APDCL Transformer Payment | 506311369305//9002001008210603 APDCL/MMT/IMPS/506311369305/SBIN0000229 Ref-Pranav Sir |
| 2025-03-05 | ₹4,000 | ICICI A/C - 058805501402 | Site Breaker Machiner Rent Kanhiya | Site Breaker Machiner Rent Kanhiya Ref-Pranav Sir 506483632586//9229001008805501 UPI/506483632586/BreakerMachi |
| 2025-03-08 | ₹11,500 | ICICI A/C - 058805501402 | Transformer Transfortation Charges | Transformer Transfortation From Guwahati to Site Hiring Charges |
| 2025-03-08 | ₹6,600 | ICICI A/C - 058805501402 | Site Office Tiles Fitting | 506799468607//9229001008805501 UPI/506799468607/OfficeTiles/dahalsubhash@sb//ICI7 413f9ac2bc043108d2d746c4ab90 |
| 2025-03-08 | ₹3,099 | ICICI A/C - 058805501402 | Amazon Purchase Labour Safety Shoes | 506701250360//9229001008805501 UPI/506701250360/Youarepayingfor/amazon@rapl/Amazo n RBL/RBA019574518258ba80903 |
| 2025-03-08 | ₹2,500 | Cash | C.V No:313, Lucky Fooding Expense | Cash Paid to Uttam Das for Lucky Fooding Expense Ref-Subhash Sir |
| 2025-03-08 | ₹5,000 | Cash | C.V No:314,Lucky House for lucky Antyeshti Sabskar | Cash Paid to Lucky House for lucky Antyeshti Sabskar Ref-Subhash Sir |
| 2025-03-10 | ₹2,250 | ICICI A/C - 058805501402 | CableTransporta/TCI Freight | 506908804436//9229001008805501 UPI/506908804436/CableTransporta/tcifreight@hdfc// ICI1d56ff20143044b4a1940a844 |
| 2025-03-10 | ₹800 | ICICI A/C - 058805501402 | TransportationCharge | 506909897938//9229001008805501 UPI/506909897938/TransportationC/mh7360437@oksbi// ICI163a6c4633a94d59911effc06 |
| 2025-03-11 | ₹4,300 | ICICI A/C - 058805501402 | ExtnsnBoardTran for Site | UPI/507016290590/ExtnsnBoardTran/kunalkanepo47@o// ICIc05d12b30f4f46d7a98c2dbb4f812eee/ 507016290590//92290010 |
| 2025-03-11 | ₹800 | Cash | C.V No:318,Nezone Pipes Unloading | Cash Paid to GVR Sir for Site Nezone Pipes Unloading and Transportation Charge |
| 2025-03-12 | ₹7,500 | ICICI A/C - 058805501402 | Shuttering Lubricant Shed Work for Site | UPI/507121279473/Lubricant/kamakhyadas1959//ICI5c1 00ce7a9d74bc7be4473b2760da6fd/ 507121279473//92290010088055 |
| 2025-03-12 | ₹8,400 | ICICI A/C - 058805501402 | Daily Labour Wages for Site | Daily Labour Wages for Site Ref- Rohan Sir UPI/507122096939/DailyLabourWage/9394495683-2@yb// ICI1ed942276d704 |
| 2025-03-12 | ₹2,100 | Cash | C.V No:322,Dalmia Cement Unloading | Cash Paid to Dalmia Cement Unloading and Transportation Charges for Site |
| 2025-03-12 | ₹1,400 | ICICI A/C - 058805501402 | WaterTankTrans/KeshabGoutam for Site | UPI/507121236653/WaterTankTrans/keshabgoutam86-//I CI9b9caa375a9245fe81d7faaff8a6df6b/ 507121236653//922900100 |
| 2025-03-12 | ₹800 | ICICI A/C - 058805501402 | LubricantTransportationExp. | UPI/507121230695/LubricantTrans/7578888962@ptye//I CId053a88f418e4b14a9c21be054aa6838/ 507121230695//922900100 |
| 2025-03-13 | ₹220 | ICICI A/C - 058805501402 | HardwareItems | 507228053602//9229001008805501 UPI/507228053602/HardwareItems/timsinak1@ibl//ICI3 368830b4aee448f876748b159fad |
| 2025-03-13 | ₹1,800 | Cash | C.V No:325,Dalmia Cement Unloading Freight | Cash Paid to Babul Haque Dalmia Cement Unloading Freight and Labour Charges |
| 2025-03-13 | ₹1,380 | ICICI A/C - 058805501402 | AugerTransportation | 507225929652//9229001008805501 UPI/507225929652/AugerTransporta/q409424813@ybl//I CIbb64d8fd37d74929afa24e461a |
| 2025-03-13 | ₹450 | ICICI A/C - 058805501402 | Shed Work Holo Section Weigh Bridge | UPI/507226306923/WeighBridge/rajibkamala085-//ICI0 f0e95e00f324d7bb0fac1dff4021570/ 507226306923//922900100880 |
| 2025-03-14 | ₹1,800 | Cash | C.V No:328,Dalmia Cement Unloading Freight | Cash Paid to Babul Haque Dalmia Cement Unloading Freight and Labour Charges |
| 2025-03-16 | ₹5,250 | ICICI A/C - 058805501402 | TMT Unloading Labour Expense | TMT Unloading Labour Expense for Site 507541587156//9229001008805501 UPI/507541587156/TMTUnloadingLab/parbinb6 |
| 2025-03-16 | ₹150 | ICICI A/C - 058805501402 | Shed Work Holo Section TMT Weigh Bridge | Shed Work Holo Section TMT Weigh Bridge507541930022//9229001008805501 UPI/507541930022/TMTWeighBridge/96350609 |
| 2025-03-17 | ₹1,260 | Cash | C.V No:331, | Cash Paid to Rajiv Bhaiya for DG Earthing and Office /Store Clearing Broom etc Purchase for Site Use |
| 2025-03-19 | ₹4,200 | Cash | C.V No:335(Dalmia Cement Unloading) | Cash Paid to Babul Haque for Dalmia Cement Unloading and Labour Charges for Site Ref-Rohan Sir |
| 2025-03-19 | ₹1,500 | Cash | C.V No:339(Sir for Auger Transportation) | Cash Paid to Pranav Sir for Auger Transportation Ref-Pranav Sir/Rajib Bhaiya |
| 2025-03-20 | ₹1,200 | ICICI A/C - 058805501402 | Sika Unloading Labour Charge | Sika Unloading Labour Charge 507961521933//9229001008805501 UPI/507961521933/SikaUnloading/7636822119@ybl//ICI |
| 2025-03-20 | ₹13,200 | ICICI A/C - 058805501402 | Sika Transportation from Guwahati to Thelamara | Sika Transportation from Guwahati to Thelamara 507961515774//9229001008805501 UPI/507961515774/SikaTrans/shivb |
| 2025-03-20 | ₹5,000 | ICICI A/C - 058805501402 | Foundtn Bolt Transportation Thelamara to Tezpur | Foundtn Bolt Transportation Thelamara to Tezpur and Tezpur to Thelamara 507961525196//9229001008805501 UPI/507 |
| 2025-03-22 | ₹6,841 | ICICI A/C - 058805501402 | Site Grocery Purchase Biscuts | 508172136338//9229001008805501 UPI/508172136338/SiteGrocery/mahadevstore123//ICIe 77bde79b95845e89e0aaa41678f3 |
| 2025-03-24 | ₹9,600 | ICICI A/C - 058805501402 | Dalmia Cement Umloading | Dalmia Cement Umloading508382572282//9229001008805501 UPI/508382572282/CementUmloading/parbinb661@oksb// ICI13 |
| 2025-03-24 | ₹1,000 | ICICI A/C - 058805501402 | Transportation Shutter | 508382192542//9229001008805501 UPI/508382192542/TransprtnShutte/sbhaque81@oksbi// ICI4d8bbecbb8cd4c4e8847f10d1 |
| 2025-03-25 | ₹1,500 | ICICI A/C - 058805501402 | Pipe Sheet Transportation | 508487834380//9229001008805501 UPI/508487834380/PipeSheetTrans/rrajahussainraj//I CId1e3099c21d649db942a80ac22 |
| 2025-03-27 | ₹2,000 | ICICI A/C - 058805501402 | FoundatnBoltTransportation | FoundatnBoltTransportation508699205778//9229001008805501 UPI/508699205778/FoundatnBoltTra/voiyajoni@oksbi// IC |
| 2025-03-28 | ₹5,063 | ICICI A/C - 058805501402 | ElectricBoxTranportation | 508703531195//9229001008805501 UPI/508703531195/ElectricBoxTran/kaustubhkonde04// ICIde44bca27aa74fc3a1d6e517e |
| 2025-04-08 | ₹5,000 | Cash | C.V No: 019 Phunil Das for Soil Items (Sand) | Cash Paid to Phunil Das for Soil Items (Sand) Ref-Rohan Sir |
| 2025-07-14 | ₹5,000 | Cash | C.V No:180 AC Block Unloading Charges | Cash Paid to Babul Haque (Labour)for AC Block from Star Smart Building Solutions Ltd for fare and Labour Charg |
| 2025-07-16 | ₹47,670 | Undeposited Funds | 5PCS Air Riveter, 10 Pcs Pvc Hammaer | 5PCS Air Riveter, 10 Pcs Pvc Hammaer Reimbursement Rohan Sir |
| 2025-07-21 | ₹5,500 | Cash | C.V No:189 AAC Block Unloading Labour Charges | Cash Paid to Babul Haque for AAC Block Unloading Labour Charges (Qty-2750*2=5500/-) |
| 2025-07-22 | ₹2,220 | Cash | C.V No:194 Ridge Cap with Roadways Fare | Cash Paid to Sandip Bhaiya for Transportation for Ridge Cap with Roadways Fare Plus Loading |
| 2025-07-23 | ₹5,500 | Cash | C.V No;196 AAC Block Unloading Labour Charges | Cash Paid to Babul Haque for AAC Block Unloading Labour Charges (Qty-2750*2=5500/-) |
| 2025-08-04 | ₹300 | Cash | C.V No:212 Materials Weight Kata Charge | Cash Paid to Sanket Bhaiya for Material Weight Kata Charge for Site |
| 2025-09-12 | ₹1,400 | Indusland Bank-156900222881 | Transportation - Plumbing Material (P1 / P2 Water | Transportation - Plumbing Material (P1 / P2 Water Treatment Plant) Ref-Rohan Sir |
| 2025-09-13 | ₹2,400 | Indusland Bank-156900222881 | Cement Unloading Labour Charges | 800bag x 3 Cement Unloading Labour Charges Sandip Bhaiya Ref-Rohan Sir |
| 2025-09-19 | ₹260 | Indusland Bank-156900222881 | Roadways fare charge ( Stabilizer Repair) | Roadways fare charge ( Stabilizer Repair) Ref-Subhash Sir UPI/562852391323/DR/DH EK/HDFC/401786@hdfcban k |
| 2025-09-20 | ₹1,820 | Indusland Bank-156900222881 | Roadways Fare Charges | Roadways Fare Charges Sanket Bhaiya UPI/526397538334/DR/the t/HDFC/ction23@okicici S41576982 |
| 2025-09-22 | ₹3,200 | Indusland Bank-156900222881 | 16 Liters Disinfectant Spray Machine 2 Pcs | 16 Liters Disinfectant Spray Machine 2 Pcs bought by Rohan Sir UPI/563125462233/DR/RO HA/ICIC/hansaraf9@icici  |
| 2025-09-24 | ₹1,839 | Indusland Bank-156900222881 | Formalin Chemical 5kg 2pcs and 10kg Weight Machine | Formalin Chemical 5kg 2pcs and 10kg Weight Machine for Site Ref-Rohan Sir |
| 2025-09-24 | ₹2,000 | Indusland Bank-156900222881 | Feed unloading Labour charges Ref- Rajiv Bhaiya | Feed unloading Labour charges Ref- Rajiv Bhaiya UPI/563326811142/DR/MI DU/SBIN/dulalom93@oksbi S6781382 |
| 2025-09-25 | ₹1,000 | Indusland Bank-156900222881 | coila 30bag carrying fare from tezpur to Site | Koyla coila 30 bags carrying fare from tezpur to Site - Ref-Rajiv / Sanket Bhaiya |
| 2025-09-26 | ₹800 | Indusland Bank-156900222881 | Transporation Fare for 200liter fridge for Site | Transporation Fare for 200liter fridge for Site Ref- Sandip Bhaiya UPI/563562599473/DR/OM /SBIN/8471846679@ybl |
| 2025-09-28 | ₹2,850 | Indusland Bank-156900222881 | Electrical items for Site P2 (Ref-Sandip Bhaiya) | Electrical items for Site P2 (Ref-Sandip Bhaiya) UPI/563750167842/DR/Ho or/UTIB/34479@okbizaxis S62695054 |
| 2025-09-28 | ₹7,566 | Indusland Bank-156900222881 | Bond 300 bags 40 cubic Labour payment Unloading | Bond 300 bags 40 cubic Labour payment Unloading Ref-Rohan Sir/Rajiv Bhaiya UPI/563767164174/DR/MI DU/CNRB/alom |
| 2025-10-03 | ₹2,400 | Indusland Bank-156900222881 | 800bag Cement Unloading Labour Charges | 800bag Cement Unloading Labour Charges Ref-Sandip Bhiya /Rohan Sir UPI/527658759303/DR/Aji m/SBIN/arbinb661@ok |
| 2025-10-03 | ₹6,666 | Indusland Bank-156900222881 | AAC BLOCK Unloading Labour Charges | AAC BLOCK Unloading Labour Charges 3333nos x 2/- =6666/- Ref-Sandip Bhaiya /Rohan Sir UPI/527698072462/DR/Aji  |
| 2025-10-06 | ₹900 | Indusland Bank-156900222881 | Kamakhya and Ujjal Material DropAutoFareCharge | Kamakhya and Ujjal Material Drop Auto Fare Charge 900/- Ref-Sanket Bhaiya UPI/527948546826/DR/SU DH/SBIN/husin |
| 2025-10-06 | ₹900 | Indusland Bank-156900222881 | Dhekiajuli Roadways Charge Ref-Sanket Bhaiya | Dhekiajuli Roadways Charge Ref-Sanket Bhaiya UPI/527914656622/DR/SU DH/SBIN/husingha@okaxis S80258139 |
| 2025-10-06 | ₹6,400 | Indusland Bank-156900222881 | AAC BLOCK UNLOADING LABOUR CHARGES | AAC BLOCK UNLOADING LABOUR CHARGES Ref-Sandip Bhaiya Rohan Sir UPI/527948569453/DR/Aji m/SBIN/arbinb661@oksbi  |
| 2025-10-06 | ₹1,100 | Indusland Bank-156900222881 | Jain Roadways Charge | Rajesh electric (Kei Wire Material Loading) Jain Roadways Charge 1000/- and Labour Charges 100/- Total 1100/-  |
| 2025-10-09 | ₹6,666 | Indusland Bank-156900222881 | AAC Block Unloading Labour Charges | AAC Block Unloading Labour Charges 3333 x 2/-=6666/- Ref-Sandip Bhaiya /Rohan Sir UPI/528287196569/DR/Aji m/SB |
| 2025-10-10 | ₹150 | Indusland Bank-156900222881 | Kamakhya Associate Material(Dhekiajuli Roadways) | Kamakhya Associate Material (Dhekiajuli Roadways Charge) Ref-Sanket Bhaiya GVR Sir UPI/564942754221/DR/DH EK/H |
| 2025-10-10 | ₹8,000 | Indusland Bank-156900222881 | Material Sheet qty 25 transportation Fare | Material Sheet qty 25 transportation Fare Charges Guwahati to Nobil Site for P1/P2 Ref-Rohan Sir Draiver numbe |
| 2025-10-18 | ₹1,370 | Indusland Bank-156900222881 | Kabja Blade Hardware items for P2 and Worker | Kabja Blade Hardware items for P2 andWorker Room Ref- Sandip Bhaiya/Rohan Sir UPI/565779100542/DR/Ma ha/UTIB/5 |
| 2025-10-24 | ₹110 | Indusland Bank-156900222881 | Roadways Charge Kamakhya Associate Material | Roadways Charge Kamakhya Associate Material Ref-Sanket Bhaiya UPI/566336836608/DR/DH EK/HDFC/401786@hdfcban k  |
| 2025-11-13 | ₹44,748 | Amino SBI Current A/C-43311518227 | Sunake Rivet Guns/Insulation Meter | Sunake Rivet Guns/Insulation Meter (Nov2-2025) Reimbursements as per Schedule (1 November - 13 November) CMPNE |
| 2025-11-24 | ₹7,500 | Indusland Bank-156900222881 | Hole for Augar Manure Shed L2 L3 L4 Panel Room | Tomas Sargiary Contractor Laser Apdcl Hole for Augar Manure Shed L2 L3 L4 Panel Room And Fan Out Site Ref-Sand |
| 2025-12-05 | ₹725 | Indusland Bank-156900222881 | Manure Shed Material items for Site Shed Work | Manure Shed Material items for Site Shed Work Ref Sandip Bhaiya/GVR Sir UPI/533919156149/DR/SA ND/INDB/7001621 |
| 2025-12-08 | ₹6,316 | Indusland Bank-156900222881 | 12mm Rope required at conveyor belt installation | 12mm Rope required at site for conveyor belt installation Ref- Sanket Bhaiya/Rohan Sir UPI/534210362408/DR/K B |
| 2025-12-23 | ₹2,273 | Indusland Bank-156900222881 | For door lock use p1 or p2 | For door lock use p1 or p2 Lock for P2 Ref Subhash Sir Ref by Rohan Sir UPI/535702636222/DR/MS P/YESB/q8393117 |
| 2026-07-03 | ₹10,000 | Indusland Bank-156900222881 | Haberuddni Roof Sheeting work Payment | Haberuddni RS 10000 L5 Roof Sheeting work Payment Ref Sudarshan Bhaiya Ref by Rohan Sir |

### Buildings (Office & Staff) — 3 expense txns, ₹24,581

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2024-09-30 | ₹9,733 | ICICI A/C - 058805501402 | 215 Hardware Purchase | For Site Use |
| 2024-09-30 | ₹13,776 | ICICI A/C - 058805501402 | HardwarePurchase | HardwarePurchase For Site use |
| 2025-03-04 | ₹1,072 | ICICI A/C - 058805501402 | HardwareItems | HardwareItems- 506375059399//9229001008805501 UPI/506375059399/HardwareItems/vyapar.17012862//IC I7c839c75fba1 |

### Poultry Cages & Equipment — 6 expense txns, ₹4,65,496

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2024-10-07 | ₹3,330 | Amino SBI Current A/C-43311518227 | Bank Charges Convert to assets | Bank Charges Convert to assets |
| 2025-01-31 | ₹29,192 | Amino SBI Current A/C-43311518227 | Bank Charges Convert to Asset | Bank Charges Convert to Asset |
| 2025-03-24 | ₹35,790 | Amino SBI Current A/C-43311518227 | Bank Charges convert to Assets. | Bank Charges convert to Assets. |
| 2025-04-11 | ₹32,184 | Amino SBI Current A/C-43311518227 | Bank Charges Convert to Assets | Bank Charges Convert to Assets |
| 2025-09-29 | ₹2,92,000 | Amino SBI Current A/C-43311518227 | Sri Venkateswara engg works. | Advance for frieght for feed vehicles(Sri sai mini transport) vehicle from hyderabad to assam |
| 2025-10-07 | ₹73,000 | Amino SBI Current A/C-43311518227 | sri venkateswara enngg works | Freight for Feed Machinery (sri sai minitransport) vehicle from hyderabad to assam |

### Furniture & Fixtures — 9 expense txns, ₹18,687

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2024-10-16 | ₹1,500 | ICICI A/C - 058805501402 | Site Chairs | Site Chairs |
| 2024-10-17 | ₹3,000 | ICICI A/C - 058805501402 | Office Furniture/KarmakarRajib | Office Furniture/KarmakarRajib |
| 2024-10-19 | ₹3,537 | ICICI A/C - 058805501402 | Officefurniture |  |
| 2024-10-23 | ₹500 | ICICI A/C - 058805501402 | Officefurniture | Officefurniture |
| 2024-12-09 | ₹550 | ICICI A/C - 058805501402 | 220- Site Workers Use Office Furniture items | Site Workers Use Office Furniture items 434456002830//9229001008805501 UPI/434456002830/officefurniture/imrana |
| 2024-12-09 | ₹2,900 | ICICI A/C - 058805501402 | 1082-Site Workers Use Office Furniture | Site Workers Use Office Furniture items 434455968269//9229001008805501 UPI/434455968269/officefurniture/getepa |
| 2025-07-08 | ₹1,100 | Cash | C.V No:162 Matt for Thelamara Office 1st Floor | Cash Paid to Sandip Bhaiya (Ref-Pranav Sir) for Purchase Matt for Thelamara Office 1st Floor |
| 2025-09-15 | ₹2,000 | Indusland Bank-156900222881 | Kitchen Furniture Purchase Advance | Kitchen Furniture Purchase total cost 6500/- Advance Payment 2000/- Here are my UPI details Name - Narad Bhatt |
| 2025-09-24 | ₹3,600 | Indusland Bank-156900222881 | Kitchen Almari Furniture Purchase | Kitchen Almari Furniture Purchase Total Cost 5600/- 15-9-25 Advance 2000/- and Remaining Due Balance Paid 24-9 |

### Office Equipment — 7 expense txns, ₹47,886

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2024-11-10 | ₹470 | Cash | C.V No:45,Invoice No:3560 | M/S Timsina Hardware Cash Paid To Kamal katel for Electrical Goods |
| 2024-11-21 | ₹2,100 | Cash | C.V No:76,Invoice No:NH/TI/1981 | Nath Hardwre Cash paid To Pranav Sir For Site Use electricals items i.e..Summersible Wire2.5,Bp Nipple-20mtr,6 |
| 2024-12-11 | ₹250 | Cash | C.V NO:89,M/S Timsina Hardware-4112 | Cash Paid to Kamal Electrician for Electrical Items Ref-Pranav Sir |
| 2024-12-11 | ₹850 | Cash | C.V NO:90,M/S Timsina Hardware-3905 | Cash Paid to Kamal Electrician for Electrical Items Ref-Pranav Sir |
| 2024-12-19 | ₹27,098 | ICICI A/C - 058805501402 | SLA705366742012 | Purchase Washing Machine Turbo Dryer for Office Ref-Subhas Sir |
| 2025-01-11 | ₹12,118 | ICICI A/C - 058805501402 | 1005 -Straight Fin Bk Heater For Office | 501120336939//9229001008805501 UPI/501120336939/OfficeEquipment/croma.42673284@// ICIfb9307b590894f1da71e203f2 |
| 2025-09-23 | ₹5,000 | Indusland Bank-156900222881 | Rechargeable Battery 10pcs @500/-Per Pcs | Rechargeable Battery 10pcs @500/-Per Pcs Ref-Subhash sir Ref-Rohan Sir UPI/526631531522/DR/BA BL/YESB/j7ixddg4 |

### Composting Equipment — 2 expense txns, ₹5,351

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2025-03-24 | ₹3,895 | Amino SBI Current A/C-43311518227 | Bank Charges convert to Asset | Bank Charges convert to Asset |
| 2025-05-23 | ₹1,456 | Amino SBI Current A/C-43311518227 | Bank charges Convert to Asset | Bank charges Convert to Asset |

### Mobile & Computer Equipment — 2 expense txns, ₹7,449

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2025-05-13 | ₹7,149 | Amino SBI Current A/C-43311518227 | Bank Charges convert to Asset | Bank Charges convert to Asset |
| 2025-06-24 | ₹300 | Cash | C.V No:139 Wireless Mouse Office Laptop | Cash Paid to Subhash Sir for Purchase Wireless Mouse (Office Use Subhash Sir Office Laptop) |

### Electrical Installation — 3 expense txns, ₹20,16,779

| Date | Amount | Paid through | Vendor / ref | Description |
|---|---:|---|---|---|
| 2025-07-07 | ₹19,36,779 | Undeposited Funds | APDCL Transforemer Charge + Load Security | APDCL Transforemer Charge + Load Security |
| 2025-08-26 | ₹60,000 | Amino SBI Current A/C-43311518227 | Electrical panels transport from vizag to tezpur. | Mai LT Electrical panels transport from vizag to tezpur( RKGS LOGISTICS) |
| 2025-09-02 | ₹20,000 | Amino SBI Current A/C-43311518227 | transport from vizag to tezpur(Rk Logistics) | Electrical panels transport from vizag to tezpur ( RK Logistics) |

## D. Capital-looking spend still sitting in expense accounts (never reclassified)

Keyword sweep over every bill / expense line posted to an operating-expense account (COGS and Depreciation excluded), ≥ ₹10,000, minus obvious repair/rent/fuel wording. **15 candidates, ₹5,41,174.** This is a shortlist to judge, not a verdict.

| Date | Amount | Expense account | Doc | Vendor | Text |
|---|---:|---|---|---|---|
| 2025-08-07 | ₹2,50,000 | Manure Management (Nabil) | bill | Gita Devi(GD Engineering) | Manure Shed Fabrication Contract Advance Gita Devi(GD Engineering) Manure Shed Fabrication Contract Advance Gi |
| 2025-07-22 | ₹68,000 | Farm Expenses (Nabil) | bill | Rabi Chowdary | 6 People Fitter Team for Fabrication (34000 Advance was Paid) Rabi Chowdary 6 People Fitter Team for Fabricati |
| 2025-08-05 | ₹30,000 | Roadways,Freight & Transportation Expenses  (Nabil) | bill | Pintu Bose(Baba Bholanath Roadways) | Put panel carrying charge Pintu Bose(Baba Bholanath Roadways) Vehicle no : WB 73 G 1495 Pintu Bose(Baba Bholan |
| 2026-07-25 | ₹22,000 | Feed Plant Expenses (Dhekiajuli) | bill | Rajshree Trading and Co | HYD JACK 75TON 70MM APC 1724 Rajshree Trading and Co For Dhekiajuli Feed Plant Weigh Bridge Rajshree Trading a |
| 2026-04-06 | ₹20,988 | Vehicle Maintenance | bill | Sonitpur Tractor and Machinery | Tractor Service from Sonitpur Tractor Sonitpur Tractor and Machinery Tractor Service from Sonitpur Tractor Tra |
| 2026-05-15 | ₹20,060 | Loading & Unloading Charges (Nabil) | bill | Vijay Singh | GI Nuts & Bolts , PSC Pole Extention Channel Vijay Singh Jahamari electrical pole work Vijay Singh PSC Pole Ex |
| 2026-06-30 | ₹19,600 | Roadways, Freight & Transportation Expenses  (Dhekiajuli) | bill | Bipin Kumar Nath | Tempo fare, Cement & machinery transport Bipin Kumar Nath Bipin Kumar Nath Month Of June Dhekiajuli Feed Plant |
| 2026-05-27 | ₹18,800 | Cars & Bikes Petrol Expenses | bill | Mainul Haque (DEF) | DEF Oil Mainul Haque (DEF) DEF Oil for Generator 400ltrs. Mainul Haque (DEF) DEF Oil for Generator |
| 2025-08-08 | ₹16,000 | Repair & Maintenance (Nabil) | expense |  | 2 Nos 7.5 H.P Motor Rewinding(30July2025) Amino SBI Current A/C-43311518227 2 Nos 7.5 H.P Motor Rewinding(30Ju |
| 2026-07-04 | ₹15,000 | Feed Plant Expenses - Dhekiajuli | expense |  | CMPIFT/0407260053222/Mr Sadhan Das Amino SBI CC Account-44656290967 30 HP Motor Rewing Feed Plant |
| 2026-07-07 | ₹15,000 | Feed Plant Expenses (Dhekiajuli) | expense |  | CMPIFT/0707260065544/Sadh an Das Amino SBI CC Account-44656290967 TO TRANSFERCMPIFT/0707260065544/Sadh an Das  |
| 2026-05-15 | ₹14,726 | Repair & Maintenance (Nabil) | bill | Vijay Singh | GI Nuts & Bolts , PSC Pole Extention Channel Vijay Singh Jahamari electrical pole work Vijay Singh PSC Pole Ex |
| 2026-05-09 | ₹11,000 | Farm Expenses (Nabil) | expense |  | goods from geeta steel fabrication Indusland Bank-156900222881 goods from geeta steel fabrication Ref by Rohan |
| 2026-03-27 | ₹10,000 | Roadways, Freight & Transportation Expenses  (Dhekiajuli) | expense |  | Transformer Transportation Charge Feed Plant Indusland Bank-156900222881 Transformer Transportation Charge Fee |
| 2026-06-18 | ₹10,000 | Repair & Maintenance (Nabil) | bill | Santosh Electrical Works | 7.5 H.P Motor Coil Winding Santosh Electrical Works Santosh Electrical Works 7.5 H.P Motor Coil Winding |
