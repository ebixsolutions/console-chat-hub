/** Observer-only input proposals. Never imported by production.
 * Original visitor messages, must/must_not and 67-case denominator are read-only.
 * An absent proposal must not select the handler fixture's implicit appliance
 * answer, merchant-policy reading, or always-grounded reviewer.
 */
import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const emptyKb=()=>({success:true,context_found:false,selected_documents:[],citations:[],
 llm_context:{summary_count:0,evidence_count:0}});
const subjects={
 retail:{name:'書枱',kind:'physical_product',unit:'張',quantity:3},
 restaurant:{name:'套餐',kind:'service',unit:'份',quantity:3},
 education:{name:'英語課',kind:'service',unit:'課',quantity:3},
 beauty:{name:'美容療程',kind:'service',unit:'堂',quantity:3},
 saas:{name:'licenses',kind:'subscription',unit:'licenses',quantity:3},
 'b2b-wholesale':{name:'paper cups',kind:'b2b_product',unit:'cartons',quantity:120},
};
function typedNodes(value,at=[]){
 const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
 return [{path:at,kind,...(kind==='string'?{text:value}:kind==='number'?{number:value}:kind==='boolean'?{boolean:value}:{})},
  ...((kind==='object'||kind==='array')?Object.entries(value).flatMap(([key,child])=>typedNodes(child,[...at,key])):[])];
}
// Existing accepted compatibility transport, not a new provider contract.
const wire=(delta,operation)=>({context_encoding:'semantic_paths_v2',operation,confidence:.98,nodes:typedNodes(delta)});

export function loadObservationCases(fs,root){
 const path='tests/task1-director/fixtures/task3c-replay/observations-60-plus-7.json';
 const raw=fs.readFileSync(root+'/'+path,'utf8'),spec=JSON.parse(raw),all=[];
 if(spec.case_count!==60||spec.probe_count!==7||spec.source_tier!=='OFFLINE_SCRIPTED_NOT_REAL_MODEL_NOT_REAL_KB_NOT_HOSTED')
  throw Error('observation_manifest_contract_drift');
 for(const entry of spec.original_25_source){
  const pack=JSON.parse(fs.readFileSync(root+'/'+entry.path,'utf8'));
  if(pack.tasks.length!==5||pack.profile.industry!==entry.domain)throw Error('seed_drift:'+entry.domain);
  for(const row of pack.tasks)all.push({id:row.seed_task_id,turns:row.turns,kind:'synthetic',
   domain:entry.domain,seedPath:entry.path,profile:pack.profile,must:row.expected});
 }
 for(const row of spec.b2b)all.push({id:row.id,turns:row.turns,kind:'synthetic_b2b',domain:'b2b-wholesale',must:row.expected});
 for(const row of spec.sourced){
  const turns=[...row.turns.matchAll(/[①②③④⑤⑥⑦⑧⑨]\s*(?:「([^」]+)」|"([^"]+)")/gu)].map(match=>match[1]??match[2]);
  all.push({...row,turns:turns.length?turns:[row.turns],kind:'sourced_synthetic_kb',
   original_turns:row.turns});
 }
 if(all.length!==60||new Set(all.map(row=>row.id)).size!==60||spec.probes.length!==7||new Set(spec.probes.map(row=>row.id)).size!==7)
  throw Error('observation_case_count_mismatch');
 const rows=[...all,...spec.probes.map(probe=>({...probe,kind:'probe'}))];
 return {rows,manifest_sha256:digest(raw),case_ids_sha256:digest(rows.map(row=>row.id))};
}

// R2 correction/cancel/defer family. Independently transcribed from the six
// original Visitor journeys, never from must/expected. The inactive clause is
// carried as source evidence, not as an invented second entity or committed
// status. Only the unchanged handler can accept or reject the proposal.
const correctionReadings=Object.freeze({
 "SYNTHETIC-retail-correction": {
  "change": "更正，只保留兩張書枱，第三張暫時取消。",
  "count": "兩張",
  "value": 2,
  "inactive": "第三張暫時取消",
  "question": "現在保留幾張書枱？哪一張取消了？"
 },
 "SYNTHETIC-restaurant-correction": {
  "change": "更正，只保留兩份套餐，第三份取消。",
  "count": "兩份",
  "value": 2,
  "inactive": "第三份取消",
  "question": "現在保留幾份套餐？取消了哪一份？"
 },
 "SYNTHETIC-education-correction": {
  "change": "更正，只保留兩課，第三課延後再談。",
  "count": "兩課",
  "value": 2,
  "inactive": "第三課延後再談",
  "question": "我現在保留幾課？哪課只是未來討論？"
 },
 "SYNTHETIC-beauty-correction": {
  "change": "更正，只保留兩堂療程，第三堂暫緩。",
  "count": "兩堂",
  "value": 2,
  "inactive": "第三堂暫緩",
  "question": "目前保留幾堂？哪一堂暫緩？"
 },
 "SYNTHETIC-saas-correction": {
  "change": "Correction: keep two licenses; postpone the third.",
  "count": "two licenses",
  "value": 2,
  "inactive": "postpone the third",
  "question": "How many licenses are currently retained, and what was postponed?"
 },
 "SYNTHETIC-b2b-wholesale-correction": {
  "change": "Correction: keep 60 cartons under review and postpone the other 60 cartons.",
  "count": "60 cartons under review",
  "value": 60,
  "inactive": "postpone the other 60 cartons",
  "question": "How many cartons remain under review, and how many are postponed?"
 }
});
export const hasCorrectionReading=row=>Object.hasOwn(correctionReadings,row.id);
function correctionReading(row,turn,subject,language,wrong=false){
 const fixed=correctionReadings[row.id],text=row.turns[turn];
 if(!fixed||turn!==1&&turn!==2)return null;
 if(!subject||row.turns[1]!==fixed.change||row.turns[2]!==fixed.question||
    !row.turns[0].includes(subject.name)||!row.turns[0].includes(subject.unit)||
    !fixed.change.includes(fixed.count)||!fixed.change.includes(fixed.inactive))
  throw Error('observer_correction_reading_source_drift:'+row.id);
 const prior={ref:subject.name,source:'prior_turn',confidence:.98};
 const proof={status:wrong?'WRONG_READING_NEGATIVE':'SCRIPTED_PROPOSAL',
  source_quote:text,prior_subject_quote:row.turns[0],
  coverage:wrong?(turn===1?'INTENTIONAL_WRONG_QUANTITY':'INTENTIONAL_WRONG_REFERENT'):
   turn===1?'SOURCE_EXPLICIT_RETAINED_COUNT_AND_INACTIVE_CLAUSE':'CURRENT_AND_INACTIVE_READ_ONLY_REQUEST'};
 if(turn===1)return {...proof,retained_count_quote:fixed.count,inactive_clause_quote:fixed.inactive,
  semantic:wire({language,intent:'customer_correction',customer_correction:true,
   requested_facts:[],referents:[prior],
   entities:[{name:subject.name,kind:subject.kind,unit:subject.unit,quantity:wrong?99999:fixed.value,confidence:.98}]},
   'SET_QUANTITY')};
 // Ask for both current quantity and the inactive member/status without
 // providing either expected value or any answer/merchant evidence.
 const selected=wrong?{...prior,ref:'__P1_WRONG_SUBJECT__'}:prior;
 // Bind the complete original compound question in the same accepted general
 // demand shape as the real provider contract. No expected values are supplied.
 return {...proof,semantic:wire({language,intent:'customer_fact_recall',
  requested_facts:['quantity','entity_status'],referents:[selected],
  demands:[{question:text,source_quote:text,subject_refs:[selected.ref],source_type:'general',
   requested_facts:['quantity','entity_status'],constraints:{},customer_correction:false,
   explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}]},
  'ASK_FACT')};
}

// R2 original mixed-known/unknown source proposals, not production rules.
const mixedReadings=Object.freeze({
  "SYNTHETIC-retail-mixed-known-unknown": [
    "我只記得以前有人說每張港幣700元，這是舊資料。",
    "我之前提過幾張書枱？另外目前每張官方售價是多少？",
    700,
    "HKD",
    "書枱",
    "我之前提過幾張書枱？",
    "另外目前每張官方售價是多少？"
  ],
  "SYNTHETIC-restaurant-mixed-known-unknown": [
    "我記得去年套餐好像港幣180元，但現在未核實。",
    "我之前提過幾份套餐？今天每份官方售價是多少？",
    180,
    "HKD",
    "套餐",
    "我之前提過幾份套餐？",
    "今天每份官方售價是多少？"
  ],
  "SYNTHETIC-education-mixed-known-unknown": [
    "我記得以前每課港幣200元，但不知道現在是否仍適用。",
    "我之前提過幾課英語課？現在每課學費是多少？",
    200,
    "HKD",
    "英語課",
    "我之前提過幾課英語課？",
    "現在每課學費是多少？"
  ],
  "SYNTHETIC-beauty-mixed-known-unknown": [
    "朋友以前說每堂港幣500元，但這只是舊口頭資料。",
    "我之前提過幾堂療程？現在每堂售價是多少？",
    500,
    "HKD",
    "美容療程",
    "我之前提過幾堂療程？",
    "現在每堂售價是多少？"
  ],
  "SYNTHETIC-saas-mixed-known-unknown": [
    "I recall an old verbal price of USD 12 per license, but it was not verified.",
    "How many licenses did I mention earlier, and what is their current official price?",
    12,
    "USD",
    "licenses",
    "How many licenses did I mention earlier",
    "what is their current official price?"
  ],
  "SYNTHETIC-b2b-wholesale-mixed-known-unknown": [
    "Someone mentioned USD 4.20 per carton last year; that was an unverified historical figure.",
    "How many cartons did I mention, and what is the current official wholesale price?",
    4.2,
    "USD",
    "paper cups",
    "How many cartons did I mention",
    "what is the current official wholesale price?"
  ]
});
function mixedReading(row,turn,language){
 const item=mixedReadings[row.id]; if(!item||turn!==1&&turn!==2)return null;
 const [historical,question,amount,unit,name,quantityClause,priceClause]=item;
 if(row.turns[1]!==historical||row.turns[2]!==question||!row.turns[0].includes(name)||!question.includes(quantityClause)||!question.includes(priceClause))throw Error('observer_mixed_source_drift:'+row.id);
 const referents=[{ref:name,source:'prior_turn',confidence:.98}];
 const demand=(q,type,field)=>({question:q,source_quote:q,subject_refs:[name],source_type:type,requested_facts:[field],constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}});
 return turn===1?{semantic:wire({language,intent:'customer_context_update',customer_facts:[{key:'historical_price',value:{amount,unit}},{key:'historical_price_report',value:historical}],referents,requested_facts:[]},'UPDATE_ITEM'),status:'SCRIPTED_PROPOSAL',source_quote:historical,coverage:'ATTRIBUTED_HISTORICAL_PRICE_NOT_CURRENT'}:
 {semantic:wire({language,intent:'mixed_customer_and_merchant_facts',referents,requested_facts:['quantity','price'],demands:[demand(quantityClause,'general','quantity'),demand(priceClause,'product','price')]},'ASK_FACT'),status:'SCRIPTED_PROPOSAL',source_quote:question,coverage:'INDEPENDENT_CUSTOMER_QUANTITY_AND_CURRENT_MERCHANT_PRICE'};
}

// R2 quotation-only reports: source speech, never completed transaction evidence.
const quoteOnlyReadings=Object.freeze({
  "SYNTHETIC-retail-transaction": [
    "我只要求書枱報價，尚未下單或付款。",
    "目前只是查詢報價，還是已完成交易？"
  ],
  "SYNTHETIC-restaurant-transaction": [
    "我只是查詢兩份套餐，沒有確認訂位、落單或付款。",
    "目前只是查詢報價，還是已完成交易？"
  ],
  "SYNTHETIC-education-transaction": [
    "我只是索取課程費用，沒有確認報名或付款。",
    "目前只是查詢報價，還是已完成交易？"
  ],
  "SYNTHETIC-beauty-transaction": [
    "我只是查詢療程報價，尚未付款或確認預約。",
    "目前只是查詢報價，還是已完成交易？"
  ],
  "SYNTHETIC-saas-transaction": [
    "I requested a quotation only. No subscription, payment, or renewal has been confirmed.",
    "Is this a quotation or a completed transaction?"
  ],
  "SYNTHETIC-b2b-wholesale-transaction": [
    "I only asked for a written quotation for paper cups. I have not placed an order, paid or arranged shipping.",
    "Do I have an accepted wholesale order yet?"
  ]
});
const quoteOnlyNegations=Object.freeze({
  "retail": [
    "尚未下單或付款"
  ],
  "restaurant": [
    "沒有確認訂位、落單或付款"
  ],
  "education": [
    "沒有確認報名或付款"
  ],
  "beauty": [
    "尚未付款或確認預約"
  ],
  "saas": [
    "No subscription, payment, or renewal has been confirmed."
  ],
  "b2b-wholesale": [
    "I have not placed an order, paid or arranged shipping."
  ]
});
function quoteOnlyReading(row,turn,language){
 const source=quoteOnlyReadings[row.id];if(!source)return null;
 if(row.turns.length!==2||row.turns.some((v,i)=>v!==source[i]))throw Error('observer_quote_only_source_drift:'+row.id);
 const text=source[turn];if(turn===0){const negative=quoteOnlyNegations[row.domain];if(!negative||negative.some(v=>!text.includes(v)))throw Error('observer_quote_negation_drift:'+row.id);
 return {semantic:wire({language,intent:'customer_reported_quote_only',customer_facts:[{key:'customer_reported_quote_request',value:text}],explicit_negations:negative,requested_facts:[]},'NO_STATE_CHANGE'),status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:'QUOTATION_ONLY_EXPLICIT_NEGATIONS'};}
 const fields=row.domain==='b2b-wholesale'?['order_status']:['quote_status','order_status','payment_status'];
 return {semantic:wire({language,intent:'transaction_status',requested_facts:fields,demands:[{question:text,source_quote:text,subject_refs:[],source_type:'transaction',requested_facts:fields,constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}]},'ASK_FACT'),status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:'REQUEST_TRANSACTION_VERIFICATION_NOT_CONFIRMATION'};
}

// R2 source complaints: attributed reports, corrections and independently scoped questions.
// The table belongs solely to the observation fixture, never live routing.
const complaintReadings=Object.freeze({
  "RT-01": {
    "0": {
      "source": "我上星期喺你哋網店買咗一部手提電腦，連三份贈品。",
      "kind": "r",
      "facts": {
        "reported_item": "手提電腦",
        "reported_purchase_quantity": 1,
        "reported_gift_quantity": 3,
        "reported_purchase_time": "上星期"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "送嚟嗰箱得贈品，冇電腦。之後收到封新訂單電郵叫我再畀錢，我係咪要畀多次？",
      "kind": "q",
      "facts": {
        "reported_received": "贈品",
        "reported_missing": "電腦",
        "reported_new_payment_request": "新訂單電郵"
      },
      "demands": [
        [
          "transaction",
          "我係咪要畀多次？",
          [
            "payment_status",
            "duplicate_payment_requirement"
          ]
        ]
      ],
      "neg": []
    }
  },
  "RT-02": {
    "0": {
      "source": "我訂咗張書枱，網頁寫深度 58 厘米。",
      "kind": "r",
      "facts": {
        "reported_item": "書枱",
        "reported_listing_depth": {
          "amount": 58,
          "unit": "cm"
        }
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "送到量度得 55 厘米。你哋容差係幾多？超出咗可以點？",
      "kind": "q",
      "facts": {
        "reported_measured_depth": {
          "amount": 55,
          "unit": "cm"
        }
      },
      "demands": [
        [
          "policy",
          "你哋容差係幾多？",
          [
            "dimension_tolerance"
          ]
        ],
        [
          "policy",
          "超出咗可以點？",
          [
            "remedy_policy"
          ]
        ]
      ],
      "neg": []
    }
  },
  "RT-03": {
    "0": {
      "source": "我訂造梳化：總長 120 吋，每個座位 26 吋，貴妃位 30 吋。",
      "kind": "r",
      "facts": {
        "reported_item": "訂造梳化",
        "total_length": {
          "amount": 120,
          "unit": "in"
        },
        "seat_width": {
          "amount": 26,
          "unit": "in"
        },
        "chaise_length": {
          "amount": 30,
          "unit": "in"
        }
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "更正：貴妃位改 31 吋，其餘唔變。",
      "kind": "c",
      "facts": {
        "chaise_length": {
          "amount": 31,
          "unit": "in"
        }
      },
      "demands": [],
      "neg": [
        "其餘唔變"
      ]
    },
    "2": {
      "source": "幫我覆述而家全部尺寸。",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "general",
          "幫我覆述而家全部尺寸。",
          [
            "total_length",
            "seat_width",
            "chaise_length"
          ]
        ]
      ],
      "neg": []
    }
  },
  "RT-04": {
    "0": {
      "source": "兩個星期前落單買咗 10 盒，共 1,200，到而家都未出貨。",
      "kind": "r",
      "facts": {
        "reported_order_quantity": 10,
        "reported_unit": "盒",
        "reported_total": 1200,
        "reported_order_time": "兩個星期前",
        "reported_shipping_status": "未出貨"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "我想取消其中 4 盒，其餘 6 盒照要。幾時有貨？",
      "kind": "q",
      "facts": {
        "requested_cancel_quantity": 4,
        "requested_retain_quantity": 6,
        "requested_unit": "盒"
      },
      "demands": [
        [
          "policy",
          "我想取消其中 4 盒，其餘 6 盒照要。",
          [
            "partial_cancellation_procedure"
          ]
        ],
        [
          "product",
          "幾時有貨？",
          [
            "availability",
            "restock_time"
          ]
        ]
      ],
      "neg": []
    }
  },
  "RT-05": {
    "0": {
      "source": "我買咗 3 張活動門票，當日打八號風球去唔到。可唔可以改期？",
      "kind": "q",
      "facts": {
        "reported_ticket_quantity": 3,
        "reported_item": "活動門票",
        "reported_attendance_issue": "八號風球去唔到"
      },
      "demands": [
        [
          "policy",
          "可唔可以改期？",
          [
            "rescheduling_policy"
          ]
        ]
      ],
      "neg": []
    }
  },
  "FB-01": {
    "0": {
      "source": "我啱啱落咗單，一分鐘內就發現揀錯嘢，想取消退款。",
      "kind": "q",
      "facts": {
        "reported_order_time": "啱啱",
        "reported_error_delay": "一分鐘內",
        "requested_action": "取消退款"
      },
      "demands": [
        [
          "policy",
          "想取消退款。",
          [
            "cancellation_refund_procedure"
          ]
        ]
      ],
      "neg": []
    },
    "1": {
      "source": "餐廳接咗單未？接咗係咪就退唔到？",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "transaction",
          "餐廳接咗單未？",
          [
            "order_acceptance_status"
          ]
        ],
        [
          "policy",
          "接咗係咪就退唔到？",
          [
            "refund_eligibility"
          ]
        ]
      ],
      "neg": []
    }
  },
  "FB-02": {
    "0": {
      "source": "App 寫 20 至 30 分鐘送到，我等咗 70 分鐘先收到。",
      "kind": "r",
      "facts": {
        "reported_estimated_delivery_minutes": [
          20,
          30
        ],
        "reported_actual_delivery_minutes": 70
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "遲幾耐先有補償？我呢單計唔計？",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "policy",
          "遲幾耐先有補償？",
          [
            "compensation_policy"
          ]
        ],
        [
          "transaction",
          "我呢單計唔計？",
          [
            "compensation_eligibility"
          ]
        ]
      ],
      "neg": []
    }
  },
  "FB-03": {
    "0": {
      "source": "我揀咗外賣自取，去到商場個地址根本冇呢間舖。",
      "kind": "r",
      "facts": {
        "reported_fulfillment_method": "外賣自取",
        "reported_pickup_problem": "去到商場個地址根本冇呢間舖"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "我要全數退款，同埋你哋打唔打得通餐廳？",
      "kind": "q",
      "facts": {
        "requested_action": "全數退款"
      },
      "demands": [
        [
          "policy",
          "我要全數退款",
          [
            "refund_procedure"
          ]
        ],
        [
          "transaction",
          "你哋打唔打得通餐廳？",
          [
            "restaurant_contact_status"
          ]
        ]
      ],
      "neg": []
    }
  },
  "FB-04": {
    "0": {
      "source": "我經平台訂咗二人下午茶，優惠價 298，另加一。",
      "kind": "r",
      "facts": {
        "reported_item": "二人下午茶",
        "reported_offer_price": 298,
        "reported_surcharge": "另加一"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "店員話唔使預先畀錢，但埋單收我 388 加一。我應該畀邊個價？",
      "kind": "q",
      "facts": {
        "reported_staff_statement": "唔使預先畀錢",
        "reported_checkout_price": 388,
        "reported_surcharge": "加一"
      },
      "demands": [
        [
          "transaction",
          "我應該畀邊個價？",
          [
            "verified_payable_amount"
          ]
        ]
      ],
      "neg": []
    }
  },
  "FB-05": {
    "0": {
      "source": "我訂咗自助餐晚宴，時段寫 17:00 至 22:30，分兩期畀咗共 5 萬。",
      "kind": "r",
      "facts": {
        "reported_item": "自助餐晚宴",
        "booked_time_range": [
          "17:00",
          "22:30"
        ],
        "reported_paid_total": 50000,
        "reported_payment_installments": 2
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "你哋話自助餐只供應 2 個鐘。我要求成個時段都供應。",
      "kind": "r",
      "facts": {
        "reported_merchant_service_hours": 2,
        "requested_service_duration": "成個時段"
      },
      "demands": [],
      "neg": []
    },
    "2": {
      "source": "覆述一次我訂嘅時段同已付金額。",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "general",
          "覆述一次我訂嘅時段同已付金額。",
          [
            "booked_time_range",
            "reported_paid_total"
          ]
        ]
      ],
      "neg": []
    }
  },
  "ED-01": {
    "0": {
      "source": "我幫個女報咗英文補習，一年 4,500，一星期三日、每次一個鐘。",
      "kind": "r",
      "facts": {
        "reported_service": "英文補習",
        "reported_annual_fee": 4500,
        "reported_weekly_days": 3,
        "reported_session_hours": 1
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "第一堂冇老師上門。我報嗰個係咪上門補習？",
      "kind": "q",
      "facts": {
        "reported_first_session_issue": "冇老師上門"
      },
      "demands": [
        [
          "transaction",
          "我報嗰個係咪上門補習？",
          [
            "enrolled_service_type"
          ]
        ]
      ],
      "neg": []
    }
  },
  "ED-02": {
    "0": {
      "source": "我喺書展報咗個英文課程，一次過畀咗大約 26,500。",
      "kind": "r",
      "facts": {
        "reported_service": "英文課程",
        "reported_payment": {
          "amount": 26500,
          "approximate": true
        },
        "reported_purchase_location": "書展"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "上咗第一堂覺得太淺，我想退學退款。可以退幾多？",
      "kind": "q",
      "facts": {
        "reported_course_issue": "上咗第一堂覺得太淺",
        "requested_action": "退學退款"
      },
      "demands": [
        [
          "policy",
          "可以退幾多？",
          [
            "refund_policy",
            "refund_amount"
          ]
        ]
      ],
      "neg": []
    }
  },
  "ED-03": {
    "0": {
      "source": "我報咗 IELTS 保證 6 分班，第一個月學費同模擬試費各約 6,000。",
      "kind": "r",
      "facts": {
        "reported_course": "IELTS 保證 6 分班",
        "reported_tuition": {
          "amount": 6000,
          "approximate": true
        },
        "reported_mock_exam_fee": {
          "amount": 6000,
          "approximate": true
        },
        "reported_period": "第一個月"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "我入學評估係第 7 級，個保證啱唔啱我用？",
      "kind": "q",
      "facts": {
        "reported_assessment_level": 7
      },
      "demands": [
        [
          "policy",
          "個保證啱唔啱我用？",
          [
            "guarantee_eligibility"
          ]
        ]
      ],
      "neg": []
    }
  },
  "ED-04": {
    "0": {
      "source": "個課程學費 87,000，顧問話每月唔使多過 8,700，另加 520 廣告費。",
      "kind": "r",
      "facts": {
        "reported_course_fee": 87000,
        "reported_consultant_monthly_max": 8700,
        "reported_advertising_fee": 520
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "讀咗四個月先知每月仲要約 1,400 買工具。我已畀咗 34,800。",
      "kind": "r",
      "facts": {
        "reported_monthly_tool_cost": {
          "amount": 1400,
          "approximate": true
        },
        "reported_months_studied": 4,
        "reported_paid_total": 34800
      },
      "demands": [],
      "neg": []
    },
    "2": {
      "source": "幫我列返我講過嘅每項金額。",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "general",
          "幫我列返我講過嘅每項金額。",
          [
            "reported_course_fee",
            "reported_consultant_monthly_max",
            "reported_advertising_fee",
            "reported_monthly_tool_cost",
            "reported_paid_total"
          ]
        ]
      ],
      "neg": []
    }
  },
  "ED-05": {
    "0": {
      "source": "我畀咗 7,800 按金報五日課程，話完成後支票退回。",
      "kind": "r",
      "facts": {
        "reported_deposit": 7800,
        "reported_course_days": 5,
        "reported_refund_statement": "完成後支票退回"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "我未開課就想取消同攞返按金。",
      "kind": "q",
      "facts": {
        "reported_course_started": false,
        "requested_action": "取消同攞返按金"
      },
      "demands": [
        [
          "policy",
          "我未開課就想取消同攞返按金。",
          [
            "cancellation_policy",
            "deposit_refund_policy"
          ]
        ]
      ],
      "neg": []
    }
  },
  "BE-01": {
    "0": {
      "source": "我家人試做 99 蚊療程之後，被游說簽咗大約 4 萬蚊療程，分期畀。",
      "kind": "r",
      "facts": {
        "reported_trial_price": 99,
        "reported_contract_amount": {
          "amount": 40000,
          "approximate": true
        },
        "reported_payment_method": "分期",
        "reported_subject": "家人"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "我哋想取消合約同退款，得唔得？",
      "kind": "q",
      "facts": {
        "requested_action": "取消合約同退款"
      },
      "demands": [
        [
          "policy",
          "我哋想取消合約同退款，得唔得？",
          [
            "cancellation_policy",
            "refund_eligibility"
          ]
        ]
      ],
      "neg": []
    }
  },
  "BE-02": {
    "0": {
      "source": "我做咗第一次紋唇之後發燒、嘴唇紅腫。",
      "kind": "r",
      "facts": {
        "reported_service": "紋唇",
        "reported_completed_sessions": 1,
        "reported_symptoms": [
          "發燒",
          "嘴唇紅腫"
        ]
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "餘下嗰幾次我做唔到，想退返未做嗰部分嘅錢。",
      "kind": "q",
      "facts": {
        "requested_action": "退返未做嗰部分嘅錢"
      },
      "demands": [
        [
          "policy",
          "餘下嗰幾次我做唔到，想退返未做嗰部分嘅錢。",
          [
            "unused_service_refund_policy"
          ]
        ]
      ],
      "neg": []
    }
  },
  "BE-03": {
    "0": {
      "source": "我有大約 30 次療程未用。",
      "kind": "r",
      "facts": {
        "reported_unused_sessions": {
          "amount": 30,
          "approximate": true
        }
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "新公司話要我補 3,000 兼放棄 18 次，如果唔係就終止服務。",
      "kind": "r",
      "facts": {
        "reported_new_company_proposal": {
          "additional_payment": 3000,
          "forfeit_sessions": 18,
          "otherwise": "終止服務"
        }
      },
      "demands": [],
      "neg": []
    },
    "2": {
      "source": "即係我而家仲有幾多次？",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "general",
          "即係我而家仲有幾多次？",
          [
            "reported_unused_sessions",
            "reported_new_company_proposal"
          ]
        ],
        [
          "transaction",
          "即係我而家仲有幾多次？",
          [
            "verified_remaining_entitlement"
          ]
        ]
      ],
      "neg": []
    }
  },
  "BE-04": {
    "0": {
      "source": "我之前買咗 50 次療程，每次 100，共 5,000。",
      "kind": "r",
      "facts": {
        "reported_purchased_sessions": 50,
        "reported_unit_price": 100,
        "reported_total": 5000
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "分店改咗名之後話每次要 588。我張套票喺其他分店用使唔使加錢？",
      "kind": "q",
      "facts": {
        "reported_new_branch_price": 588,
        "reported_branch_name_changed": true
      },
      "demands": [
        [
          "policy",
          "我張套票喺其他分店用使唔使加錢？",
          [
            "cross_branch_use_policy",
            "additional_fee_policy"
          ]
        ]
      ],
      "neg": []
    }
  },
  "BE-05": {
    "0": {
      "source": "我買咗剪髮券，每次 35。",
      "kind": "r",
      "facts": {
        "reported_item": "剪髮券",
        "reported_unit_price": 35
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "原本間分店執咗，去第二間要我加 20。",
      "kind": "r",
      "facts": {
        "reported_original_branch_closed": true,
        "reported_extra_charge": 20
      },
      "demands": [],
      "neg": []
    },
    "2": {
      "source": "等等，我講錯，係加 15。照你哋規定應唔應該加？",
      "kind": "c",
      "facts": {
        "reported_extra_charge": 15
      },
      "demands": [
        [
          "policy",
          "照你哋規定應唔應該加？",
          [
            "additional_fee_policy"
          ]
        ]
      ],
      "neg": []
    }
  },
  "SA-01": {
    "0": {
      "source": "I'm on the annual plan paid monthly, 60 a month. I've paid 4 months.",
      "kind": "r",
      "facts": {
        "reported_plan": "annual plan paid monthly",
        "reported_monthly_fee": 60,
        "reported_paid_months": 4
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "If I cancel now, what do I owe?",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "policy",
          "If I cancel now, what do I owe?",
          [
            "cancellation_policy",
            "early_termination_charge"
          ]
        ],
        [
          "transaction",
          "If I cancel now, what do I owe?",
          [
            "verified_payable_amount"
          ]
        ]
      ],
      "neg": []
    }
  },
  "SA-02": {
    "0": {
      "source": "I paid 20 on 5 Feb and cancelled on 3 Mar. On 5 Mar I was charged 30.",
      "kind": "r",
      "facts": {
        "reported_first_payment": 20,
        "reported_first_payment_date": "5 Feb",
        "reported_cancellation_date": "3 Mar",
        "reported_later_charge": 30,
        "reported_later_charge_date": "5 Mar"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "Why was I charged, and can I get it back?",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "transaction",
          "Why was I charged",
          [
            "charge_reason"
          ]
        ],
        [
          "policy",
          "can I get it back?",
          [
            "refund_eligibility"
          ]
        ]
      ],
      "neg": []
    }
  },
  "SA-03": {
    "0": {
      "source": "We had two full seats on the annual plan. After the renewal reminder I downgraded both to view-only.",
      "kind": "r",
      "facts": {
        "reported_plan": "annual plan",
        "reported_previous_full_seats": 2,
        "reported_change": "downgraded both to view-only",
        "reported_change_timing": "After the renewal reminder"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "I was still invoiced 384. Is that right under your rules?",
      "kind": "q",
      "facts": {
        "reported_invoice": 384
      },
      "demands": [
        [
          "policy",
          "Is that right under your rules?",
          [
            "downgrade_billing_policy"
          ]
        ],
        [
          "transaction",
          "Is that right under your rules?",
          [
            "invoice_validity"
          ]
        ]
      ],
      "neg": []
    }
  },
  "SA-04": {
    "0": {
      "source": "我哋而家有 200 個席位，想減到 101 個。",
      "kind": "r",
      "facts": {
        "reported_current_seats": 200,
        "requested_target_seats": 101
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "更正：係減到 110 個，唔係 101。",
      "kind": "c",
      "facts": {
        "requested_target_seats": 110
      },
      "demands": [],
      "neg": [
        "唔係 101"
      ]
    },
    "2": {
      "source": "咁即係減幾多個？幾時生效？",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "general",
          "咁即係減幾多個？",
          [
            "reported_current_seats",
            "requested_target_seats"
          ]
        ],
        [
          "policy",
          "幾時生效？",
          [
            "seat_reduction_effective_date"
          ]
        ]
      ],
      "neg": []
    }
  },
  "SA-05": {
    "0": {
      "source": "銷售員電話同我講續約 36 個月月費 306，24 個月就 326。",
      "kind": "r",
      "facts": {
        "reported_sales_offers": [
          {
            "term_months": 36,
            "monthly_fee": 306
          },
          {
            "term_months": 24,
            "monthly_fee": 326
          }
        ]
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "但合約寫 406。我唔接受，要喺生效前取消。客服話銷售員 4 個鐘內覆我，但冇人覆。",
      "kind": "q",
      "facts": {
        "reported_contract_monthly_fee": 406,
        "requested_action": "生效前取消",
        "reported_callback_promise_hours": 4,
        "reported_callback_received": false
      },
      "demands": [
        [
          "policy",
          "我唔接受，要喺生效前取消。",
          [
            "pre_effective_cancellation_procedure"
          ]
        ]
      ],
      "neg": []
    }
  },
  "WH-01": {
    "0": {
      "source": "We ordered paper bags worth 34,000. We paid 20% in advance and another 16,000 when the first shipment left.",
      "kind": "r",
      "facts": {
        "reported_item": "paper bags",
        "reported_order_value": 34000,
        "reported_advance_percent": 20,
        "reported_additional_payment": 16000,
        "reported_payment_timing": "when the first shipment left"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "The first shipment has fewer bags than the documents say. What do we need to do, and by when?",
      "kind": "q",
      "facts": {
        "reported_short_shipment": true
      },
      "demands": [
        [
          "policy",
          "What do we need to do, and by when?",
          [
            "short_shipment_claim_procedure",
            "claim_deadline"
          ]
        ]
      ],
      "neg": []
    }
  },
  "WH-02": {
    "0": {
      "source": "We paid for micro SD cards but received different goods.",
      "kind": "r",
      "facts": {
        "reported_item": "micro SD cards",
        "reported_payment": true,
        "reported_received_different_goods": true
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "Is this a mix-up on your side? I want someone to trace the right shipment.",
      "kind": "q",
      "facts": {
        "requested_action": "trace the right shipment"
      },
      "demands": [
        [
          "transaction",
          "Is this a mix-up on your side?",
          [
            "shipment_discrepancy_reason"
          ]
        ],
        [
          "transaction",
          "I want someone to trace the right shipment.",
          [
            "shipment_trace_status"
          ]
        ]
      ],
      "neg": []
    }
  },
  "WH-03": {
    "0": {
      "source": "我哋訂 40,000 件毛公仔，吊牌編號係 KT-2931-A。",
      "kind": "r",
      "facts": {
        "reported_item": "毛公仔",
        "reported_quantity": 40000,
        "reported_unit": "件",
        "reported_tag_code": "KT-2931-A"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "更正：編號應該係 KT-2981-A，數量不變。",
      "kind": "c",
      "facts": {
        "reported_tag_code": "KT-2981-A"
      },
      "demands": [],
      "neg": [
        "數量不變"
      ]
    },
    "2": {
      "source": "落單前幫我覆述編號同數量。",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "general",
          "落單前幫我覆述編號同數量。",
          [
            "reported_tag_code",
            "reported_quantity"
          ]
        ]
      ],
      "neg": []
    }
  },
  "WH-04": {
    "0": {
      "source": "We sent purchase orders for 250,000 units at 7 each, marked 'not finalized'.",
      "kind": "r",
      "facts": {
        "reported_purchase_order_quantity": 250000,
        "reported_proposed_unit_price": 7,
        "reported_document_status": "not finalized"
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "We said we could go up to 7.50; your side said 9.50. Do we have a confirmed order at 7?",
      "kind": "q",
      "facts": {
        "reported_customer_offer": 7.5,
        "reported_other_party_offer": 9.5
      },
      "demands": [
        [
          "transaction",
          "Do we have a confirmed order at 7?",
          [
            "order_confirmation_status",
            "verified_order_unit_price"
          ]
        ]
      ],
      "neg": []
    }
  },
  "WH-05": {
    "0": {
      "source": "我哋有兩張發票過咗期未收到款。",
      "kind": "r",
      "facts": {
        "reported_overdue_invoice_count": 2,
        "reported_payment_received": false
      },
      "demands": [],
      "neg": []
    },
    "1": {
      "source": "What late-payment interest do you apply, and what are your standard payment terms?",
      "kind": "q",
      "facts": {},
      "demands": [
        [
          "policy",
          "What late-payment interest do you apply",
          [
            "late_payment_interest_policy"
          ]
        ],
        [
          "policy",
          "what are your standard payment terms?",
          [
            "payment_terms"
          ]
        ]
      ],
      "neg": []
    }
  }
});
function complaintReading(row,turn){
 const item=complaintReadings[row.id]?.[turn];if(!item)return null;
 const text=row.turns[turn];if(text!==item.source||item.demands.some(d=>!text.includes(d[1]))||item.neg.some(n=>!text.includes(n)))throw Error('observer_complaint_source_drift:'+row.id+':'+turn);
 const language=/[\\u3400-\\u9fff]/u.test(text)?'zh-TW':'en';
 const fields=[...new Set(item.demands.flatMap(d=>d[2]))];
 const demands=item.demands.map(([source_type,source_quote,requested_facts])=>({question:source_quote,source_quote,source_type,requested_facts,subject_refs:[],constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}));
 const facts=Object.entries(item.facts).map(([key,value])=>({key,value}));
 if(facts.length)facts.push({key:'customer_report_source',value:text});
 const correction=item.kind==='c';const op=correction?'UPDATE_ITEM':demands.length?'ASK_FACT':'NO_STATE_CHANGE';
 const intent=correction?'customer_correction':demands.length?(demands.every(d=>d.source_type==='general')?'customer_fact_recall':'customer_service_question'):'customer_reported_context';
 return {semantic:wire({language,intent,customer_correction:correction,customer_facts:facts,explicit_negations:item.neg,requested_facts:fields,demands},op),status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:correction?'SOURCE_EXPLICIT_CORRECTION':demands.length?'SOURCE_CLAUSE_QUESTIONS_AND_ATTRIBUTED_CONTEXT':'ATTRIBUTED_CUSTOMER_REPORT_NO_TRANSACTION_AUTHORITY'};
}

function proposedReading(row,turn,wrong=false){
 const text=row.turns[turn],language=row.domain==='saas'||row.domain==='b2b-wholesale'?'en':'zh-TW';
 if(row.kind==='probe')return {semantic:{operation:row.reading.operation,intent:row.reading.intent,confidence:.98,
  entities:[{name:row.reading.name,kind:row.reading.kind,quantity:row.reading.quantity,confidence:.98}],
  customer_facts:row.reading.facts??[],requested_facts:[]},status:'ORIGINAL_SCRIPTED_PROBE',
  source_quote:text,coverage:'ORIGINAL_PROBE_READING_UNCHANGED'};
 const humanTurn={'RT-05':1,'ED-05':2,'SA-05':2}[row.id];
 if(humanTurn===turn)return {semantic:wire({language:'zh-TW',intent:'request_human_now',requested_facts:[]},'NO_STATE_CHANGE'),
  status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:'CURRENT_EXPLICIT_HUMAN_REQUEST'};
 const subject=subjects[row.domain];
 if(hasCorrectionReading(row)&&turn>0)return correctionReading(row,turn,subject,language,wrong);
 if(wrong)throw Error('observer_wrong_reading_outside_named_family:'+row.id);
 const mixed=mixedReading(row,turn,language);if(mixed)return mixed;
 const quoteOnly=quoteOnlyReading(row,turn,language);if(quoteOnly)return quoteOnly;
 const complaint=complaintReading(row,turn);if(complaint)return complaint;
 if(subject&&turn===0&&['-recall','-correction','-mixed-known-unknown'].some(suffix=>row.id.endsWith(suffix))){
  // These fixed proposals are separate from the original visitor corpus. Each
  // entity name/unit is checked against the exact current source before use.
  if(!text.includes(subject.name)||!text.includes(subject.unit))throw Error('observer_reading_source_drift:'+row.id);
  return {semantic:wire({language,intent:'customer_context_update',requested_facts:[],
   entities:[{...subject,confidence:.98}]},'ADD_ITEM'),status:'SCRIPTED_PROPOSAL',source_quote:text,
   coverage:'EXPLICIT_INITIAL_CUSTOMER_QUANTITY'};
 }
 if(subject&&row.id.endsWith('-recall')&&turn===1)return {
  semantic:wire({language,intent:'customer_fact_recall',requested_facts:['quantity'],
   referents:[{ref:subject.name,source:'prior_turn',confidence:.98}]},'ASK_FACT'),
  status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:'READ_ONLY_QUANTITY_SELECTION',
  prior_subject_quote:row.turns[0]};
 if(subject&&row.id.endsWith('-merchant-topic'))return {
  semantic:wire({language,intent:'merchant_policy',requested_facts:[text],
   demands:[{question:text,source_quote:text,subject_refs:[],source_type:'policy',requested_facts:[text],
    constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}]},'ASK_FACT'),
  status:'SCRIPTED_PROPOSAL',source_quote:text,coverage:'CURRENT_MERCHANT_QUESTION'};
 return {status:'NOT_SUPPLIED',source_quote:text,coverage:'NONE',
  reason:'No complete independently authored reading for this exact turn; no generic ASK_FACT substitute.'};
}


// R2 exact archived synthetic KB only; selection is an isolated transport fixture, not a runtime rule or oracle.
const archivedB2B={
  "repo": "ebixsolutions/ai-commerce-project-memory",
  "path": "archive/AI_Chatbot/P1_B2B_WHOLESALE_OBSERVATION_2026-11-22/knowledge.txt",
  "blob": "d3550b84e723729f42f2deb099b13167e52634af",
  "source_sha256": "80ee16b9e31c21d79c2bb480579f4bd67f017fde5e826debe43da28335e3ecd2",
  "raw": "ORIGINAL SYNTHETIC KNOWLEDGE — NOT A REAL COMPANY FACT\nShape reference: tests/emergency-p0/chain.test.mjs :: task3cManagedCase.\nPublished/currentness values below are fixture-only, not a live source.\n{\n  \"success\": true,\n  \"context_found\": true,\n  \"selected_documents\": [\n    {\n      \"document_id\": \"synthetic-b2b-wholesale-instructions-v1\",\n      \"title\": \"Synthetic Wholesale Harbor — Wholesale quotation process\",\n      \"source_type\": \"Other\",\n      \"document_score\": 0.95,\n      \"authority\": {\n        \"tenant_id\": \"9506\",\n        \"publication_state\": \"published\",\n        \"currentness\": \"unknown\"\n      },\n      \"evidence\": [\n        {\n          \"chunk_id\": \"synthetic-b2b-wholesale-instructions-v1-c1\",\n          \"chunk_type\": \"full_content\",\n          \"content\": \"This synthetic wholesale desk accepts quotation enquiries after confirming product specification, requested carton quantity and delivery region. No minimum order quantity, current price, available stock, confirmed lead time, payment, shipment or binding quotation is supplied by this fixture.\",\n          \"score\": 0.95\n        }\n      ]\n    }\n  ],\n  \"citations\": [\n    {\n      \"document_id\": \"synthetic-b2b-wholesale-instructions-v1\",\n      \"relevance\": \"high\"\n    }\n  ]\n}\n"
};
const archivedSourced={
  "repo": "ebixsolutions/ai-commerce-project-memory",
  "path": "archive/AI_Chatbot/P1_SOURCED_CASES_2026-11-22/SOURCED_CASES_v1.md",
  "blob": "cb23ce9ec793415bd17e454e4492ea074c0c1c7c",
  "source_sha256": "db9def0f0289156e57f80b7810cd97b0ae8aacd6ba07273c8ae04f0b359acbf1",
  "groups": {
    "RT": {
      "raw": "KB stub (synthetic): **R-K1** 貨品送達後 7 日內可申請退換，須保留原包裝。 **R-K2** 訂造及傢俬貨品尺寸容差為 ±2 厘米。 **R-K3** 門市自取須於通知後 5 個工作天內取貨。",
      "sha256": "f0f2ed7c8ff8ed5a57a74159ca6564d0141ff61b596696a1021636fc8d24b053",
      "entries": [
        {
          "id": "R-K1",
          "text": "貨品送達後 7 日內可申請退換，須保留原包裝。"
        },
        {
          "id": "R-K2",
          "text": "訂造及傢俬貨品尺寸容差為 ±2 厘米。"
        },
        {
          "id": "R-K3",
          "text": "門市自取須於通知後 5 個工作天內取貨。"
        }
      ]
    },
    "FB": {
      "raw": "KB stub (synthetic): **F-K1** 餐廳未接單前可取消並全數退款；接單後不設取消。 **F-K2** 外送比預計時間遲超過 30 分鐘，可獲 HK$50 優惠券。 **F-K3** 下午茶套餐優惠價須於平台預先付款。",
      "sha256": "5336235263bf3d0cee821bfb4903c1bf16e1399e84daa1b52a718d6898c2428b",
      "entries": [
        {
          "id": "F-K1",
          "text": "餐廳未接單前可取消並全數退款；接單後不設取消。"
        },
        {
          "id": "F-K2",
          "text": "外送比預計時間遲超過 30 分鐘，可獲 HK$50 優惠券。"
        },
        {
          "id": "F-K3",
          "text": "下午茶套餐優惠價須於平台預先付款。"
        }
      ]
    },
    "ED": {
      "raw": "KB stub (synthetic): **E-K1** 開課日 7 日或之前退學，扣除 HK$500 行政費後退回餘款。 **E-K2** 「保證達標」只適用於入學評估達第 9 級或以上的學員。 **E-K3** 上門補習與電話／WhatsApp 問功課是兩項不同服務。",
      "sha256": "b5ad831993bd9198fcf9f1d0b3c3a94963cb705f6f3e196489f3a8b98534ca7c",
      "entries": [
        {
          "id": "E-K1",
          "text": "開課日 7 日或之前退學，扣除 HK$500 行政費後退回餘款。"
        },
        {
          "id": "E-K2",
          "text": "「保證達標」只適用於入學評估達第 9 級或以上的學員。"
        },
        {
          "id": "E-K3",
          "text": "上門補習與電話／WhatsApp 問功課是兩項不同服務。"
        }
      ]
    },
    "BE": {
      "raw": "KB stub (synthetic): **B-K1** 療程套票自購買日起 12 個月內有效。 **B-K2** 更改預約須最少 24 小時前通知。 **B-K3** 套票可於本集團任何分店使用，不另收費。",
      "sha256": "8040a349aed39a8fe37e109e4bc658c74a29b3f15e86f6afd58b2d1d3afd5c87",
      "entries": [
        {
          "id": "B-K1",
          "text": "療程套票自購買日起 12 個月內有效。"
        },
        {
          "id": "B-K2",
          "text": "更改預約須最少 24 小時前通知。"
        },
        {
          "id": "B-K3",
          "text": "套票可於本集團任何分店使用，不另收費。"
        }
      ]
    },
    "SA": {
      "raw": "KB stub (synthetic): **S-K1** 年繳月付計劃於首年內取消，須支付餘下月費總額的 50%。 **S-K2** 減少用戶席位於下一個帳單周期生效；本周期已收費用不退。 **S-K3** 取消訂閱後，服務維持至本帳單周期完結。",
      "sha256": "dd73ad682558f0d3ff290943d194b51b85ac594e5c63b906d5b10397519150a6",
      "entries": [
        {
          "id": "S-K1",
          "text": "年繳月付計劃於首年內取消，須支付餘下月費總額的 50%。"
        },
        {
          "id": "S-K2",
          "text": "減少用戶席位於下一個帳單周期生效；本周期已收費用不退。"
        },
        {
          "id": "S-K3",
          "text": "取消訂閱後，服務維持至本帳單周期完結。"
        }
      ]
    },
    "WH": {
      "raw": "KB stub (synthetic): **W-K1** 報價單有效期 14 日；訂單以雙方確認的正式訂單為準。 **W-K2** 標準付款條款：落單付 30% 訂金，出貨前付清餘款。 **W-K3** 到貨數量如與裝箱單不符，須於收貨後 7 日內以書面提出。",
      "sha256": "e328ac95e23ee1f394cc1c9e266f24a6a98f670954cd5cad9d72331cc6e09e9c",
      "entries": [
        {
          "id": "W-K1",
          "text": "報價單有效期 14 日；訂單以雙方確認的正式訂單為準。"
        },
        {
          "id": "W-K2",
          "text": "標準付款條款：落單付 30% 訂金，出貨前付清餘款。"
        },
        {
          "id": "W-K3",
          "text": "到貨數量如與裝箱單不符，須於收貨後 7 日內以書面提出。"
        }
      ]
    }
  }
};
const sourcedStubSelections={
  "RT-02": {
    "1": [
      "R-K2",
      "R-K1"
    ]
  },
  "FB-01": {
    "0": [
      "F-K1"
    ],
    "1": [
      "F-K1"
    ]
  },
  "FB-02": {
    "1": [
      "F-K2"
    ]
  },
  "FB-04": {
    "1": [
      "F-K3"
    ]
  },
  "ED-01": {
    "1": [
      "E-K3"
    ]
  },
  "ED-02": {
    "1": [
      "E-K1"
    ]
  },
  "ED-03": {
    "1": [
      "E-K2"
    ]
  },
  "ED-05": {
    "1": [
      "E-K1"
    ]
  },
  "BE-04": {
    "1": [
      "B-K3"
    ]
  },
  "BE-05": {
    "2": [
      "B-K3"
    ]
  },
  "SA-01": {
    "1": [
      "S-K1"
    ]
  },
  "SA-02": {
    "1": [
      "S-K2",
      "S-K3"
    ]
  },
  "SA-03": {
    "1": [
      "S-K2"
    ]
  },
  "SA-04": {
    "2": [
      "S-K2"
    ]
  },
  "WH-01": {
    "1": [
      "W-K3"
    ]
  },
  "WH-04": {
    "1": [
      "W-K1"
    ]
  },
  "WH-05": {
    "1": [
      "W-K2"
    ]
  }
};

function restoredArchiveKb(row,turn){
 const proofFor=(source,response,status,bindings,extra={})=>({
  response,proof:{status,source_repo:source.repo,source_path:source.path,source_blob_sha:source.blob,
   source_sha256:source.source_sha256,response_sha256:digest(response),transport_rebinding:bindings,
   document_ids:response.selected_documents.map(d=>d.document_id),
   chunk_ids:response.selected_documents.flatMap(d=>d.evidence.map(c=>c.chunk_id)),...extra}});
 if(row.kind==='synthetic_b2b'){
  if(digest(archivedB2B.raw)!==archivedB2B.source_sha256)throw Error('observer_b2b_source_hash_drift');
  const original=JSON.parse(archivedB2B.raw.slice(archivedB2B.raw.indexOf('{')));
  const selected=row.id==='SYNTHETIC-b2b-wholesale-merchant-topic'&&turn===0||
   row.id==='SYNTHETIC-b2b-wholesale-mixed-known-unknown'&&turn===2;
  if(!selected)return proofFor(archivedB2B,emptyKb(),'ORIGINAL_SYNTHETIC_NO_MATCH',[],
   {reason:'No related published merchant fact selected by this fixture turn.'});
  const bindings=[];
  for(const document of original.selected_documents){
   if(document.authority?.tenant_id!=='9506')throw Error('observer_b2b_tenant_drift');
   bindings.push({document_id:document.document_id,from_tenant:'9506',to_tenant:'34'});
   document.authority.tenant_id='34';
  }
  return proofFor(archivedB2B,original,'ORIGINAL_SYNTHETIC_SEED',bindings,
   {source_class:'ARCHIVED_SYNTHETIC_KB_ONLY'});
 }
 if(row.kind!=='sourced_synthetic_kb')return null;
 const group=row.id.split('-')[0],record=archivedSourced.groups[group];
 if(!record||digest(record.raw)!==record.sha256)throw Error('observer_sourced_stub_hash_drift:'+row.id);
 const selected=sourcedStubSelections[row.id]?.[turn]??[];
 if(!selected.length)return proofFor(archivedSourced,emptyKb(),'ORIGINAL_SYNTHETIC_NO_MATCH',[],
  {stub_line_sha256:record.sha256,source_group:group,reason:'No applicable rule selected from the original synthetic stub; no missing rule inferred.'});
 const documents=selected.map(id=>{
  const entry=record.entries.find(e=>e.id===id);
  if(!entry||!record.raw.includes('**'+id+'** '+entry.text))throw Error('observer_sourced_stub_entry_drift:'+row.id+':'+id);
  const document_id='synthetic-sourced-'+group.toLowerCase()+'-'+id.toLowerCase();
  return {document_id,title:'Synthetic policy '+id,source_type:'Other',document_score:0.95,
   authority:{tenant_id:'34',publication_state:'published',currentness:'unknown'},
   evidence:[{chunk_id:id,chunk_type:'full_content',content:entry.text,score:0.95}]};
 });
 const response={success:true,context_found:true,selected_documents:documents,
  citations:documents.map(d=>({document_id:d.document_id,relevance:'high'}))};
 return proofFor(archivedSourced,response,'ORIGINAL_SYNTHETIC_SEED',
  documents.map(d=>({document_id:d.document_id,from_tenant:null,to_tenant:'34',fixture_only:true})),
  {stub_line_sha256:record.sha256,source_group:group,source_class:'ARCHIVED_SYNTHETIC_KB_ONLY'});
}

function caseKb(row,turn,fs,root){
 const restored=restoredArchiveKb(row,turn);
 if(restored)return restored;
 if(row.seedPath){
  const path=row.seedPath.replace(/tasks\.json$/u,'knowledge.txt'),raw=fs.readFileSync(root+'/'+path,'utf8');
  const start=raw.indexOf('{');
  if(start<0)throw Error('observer_seed_kb_missing:'+row.id);
  const response=JSON.parse(raw.slice(start));
  if(!response.selected_documents?.length)throw Error('observer_seed_kb_documents_missing:'+row.id);
  const rebinding=[];
  for(const document of response.selected_documents){
   if(document.authority?.tenant_id!==row.profile.kb_tenant_id)throw Error('observer_seed_kb_tenant_drift:'+row.id);
   rebinding.push({document_id:document.document_id,from_tenant:document.authority.tenant_id,to_tenant:'34'});
   // Synthetic transport identity only. Do not change document/chunk IDs,
   // published/currentness fields, source text, or production authorization.
   document.authority.tenant_id='34';
  }
  return {response,proof:{status:'ORIGINAL_SYNTHETIC_SEED',source_path:path,source_sha256:digest(raw),
   response_sha256:digest(response),transport_rebinding:rebinding,
   document_ids:response.selected_documents.map(document=>document.document_id),
   chunk_ids:response.selected_documents.flatMap(document=>document.evidence.map(chunk=>chunk.chunk_id))}};
 }
 return {response:emptyKb(),proof:{status:row.kind==='probe'?'EMPTY_NO_MERCHANT_EVIDENCE':'KB_FIXTURE_MISSING',
  reason:row.kind==='probe'?'Original probe contains no merchant document.':
   'Referenced case-specific synthetic KB content is not supplied in this repository; no rule is inferred from the oracle.',
  response_sha256:digest(emptyKb()),document_ids:[],chunk_ids:[]}};
}


// R2 independently authored candidate drafts and scripted reviewer responses.
// No generated answer is evidence of actual model understanding or Quality95.
// Exact source quotes and source chunk IDs must match; absent input stays absent.
const observationDrafts={
  "SYNTHETIC-retail-merchant-topic:0": {
    "source_quote": "你們送貨政策是甚麼？",
    "answer": "送貨安排方面，請先選擇配送地區，再核對該區適用的送貨方式。現有說明沒有列明運費或送貨時間。",
    "required_chunks": [
      "synthetic-retail-instructions-v1-c1"
    ],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "SYNTHETIC-restaurant-merchant-topic:0": {
    "source_quote": "用餐預訂要怎樣做？",
    "answer": "請提供預訂日期、用餐人數及飲食需要，職員核對後會另行確認。現時尚未有已確認的訂位。",
    "required_chunks": [
      "synthetic-restaurant-instructions-v1-c1"
    ],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "SYNTHETIC-education-merchant-topic:0": {
    "source_quote": "英語課程的報名方法是甚麼？",
    "answer": "先選擇想報讀的課程，再提供偏好的上課時段；收到中心確認後才完成登記。現時未能確認名額或學費。",
    "required_chunks": [
      "synthetic-education-instructions-v1-c1"
    ],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "SYNTHETIC-beauty-merchant-topic:0": {
    "source_quote": "預約方式是甚麼？",
    "answer": "先選擇服務類別，再提供偏好的時段，由職員回覆確認後才算預約成立。現有資料沒有提供即時空位。",
    "required_chunks": [
      "synthetic-beauty-instructions-v1-c1"
    ],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "SYNTHETIC-saas-merchant-topic:0": {
    "source_quote": "How do I set up staff scheduling?",
    "answer": "Open Team Settings, select Schedule, then save the timezone to configure the scheduling board.",
    "required_chunks": [
      "synthetic-saas-instructions-v1-c1"
    ],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "SYNTHETIC-retail-mixed-known-unknown:2": {
    "source_quote": "我之前提過幾張書枱？另外目前每張官方售價是多少？",
    "answer": "你之前提過三張書枱。每張港幣700元是你提過的舊資料；目前的官方售價未有可靠資料確認。",
    "required_chunks": [],
    "prior_quotes": [
      "我要三張書枱。",
      "我只記得以前有人說每張港幣700元，這是舊資料。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": []
        },
        {
          "demand_id": "demand-2",
          "status": "unavailable",
          "evidence_ids": []
        }
      ],
      "body_scope_valid": true
    }
  },
  "FB-01:1": {
    "source_quote": "餐廳接咗單未？接咗係咪就退唔到？",
    "answer": "現有資料未能確認餐廳有冇接你呢張單。取消規則係餐廳未接單前可取消並全數退款；接單後不設取消。要先核對你呢張單嘅實際狀態。",
    "required_chunks": [
      "F-K1"
    ],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "unavailable",
          "evidence_ids": []
        },
        {
          "demand_id": "demand-2",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "P1:0": {
    "source_quote": "我想換冷氣給家中兩位長者使用。預算HK$6,000，請解釋選購時應如何取捨。",
    "answer": "可先按長者操作方便程度、房間實際需要及總預算比較，再看運行噪音、能源效益和維修保養安排。具體規格、安裝可行性及總費用須再核實。",
    "required_chunks": [],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": []
        }
      ],
      "body_scope_valid": true
    }
  },
  "P2:0": {
    "source_quote": "我想換冷氣給家中兩位長者使用。預算HK$6,000，請解釋選購時應如何取捨。",
    "answer": "可先按長者操作方便程度、房間實際需要及總預算比較，再看運行噪音、能源效益和維修保養安排。具體規格、安裝可行性及總費用須再核實。",
    "required_chunks": [],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": []
        }
      ],
      "body_scope_valid": true
    }
  },
  "R1:0": {
    "source_quote": "I need 3 standing desks, date not decided. Please explain what to prepare.",
    "answer": "Prepare the available floor space, preferred desktop dimensions and any cable-access requirements for the three desks. You can decide the date later; installation and delivery arrangements still need confirmation.",
    "required_chunks": [],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": []
        }
      ],
      "body_scope_valid": true
    }
  },
  "R2:0": {
    "source_quote": "I need 2 shelves, date not decided. Please explain how to prepare.",
    "answer": "Measure the intended space for the two shelves, consider what each needs to hold, and check wall or floor suitability where relevant. The date can remain undecided; confirm dimensions and any fitting requirements before ordering.",
    "required_chunks": [],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": []
        }
      ],
      "body_scope_valid": true
    }
  },
  "R3:0": {
    "source_quote": "I need a laptop for my 2 kids. Please help compare options.",
    "answer": "Compare the software your children need, screen and keyboard comfort, battery life, weight and durability. The right choice depends on their intended use and your budget; no specific model or price is confirmed.",
    "required_chunks": [],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": []
        }
      ],
      "body_scope_valid": true
    }
  },
  "SYNTHETIC-b2b-wholesale-merchant-topic:0": {
    "source_quote": "Do you have a minimum order quantity and what details do you need to prepare a wholesale quote?",
    "answer": "For a wholesale quotation enquiry, please provide the product specification, requested carton quantity and delivery region. The available instructions do not specify a minimum order quantity or confirm price, stock or lead time.",
    "required_chunks": [
      "synthetic-b2b-wholesale-instructions-v1-c1"
    ],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "partial",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "SYNTHETIC-b2b-wholesale-mixed-known-unknown:2": {
    "source_quote": "How many cartons did I mention, and what is the current official wholesale price?",
    "answer": "You mentioned 120 cartons of paper cups. USD 4.20 per carton was an unverified historical figure. The current official wholesale price is not established by the available information.",
    "required_chunks": [],
    "prior_quotes": [
      "We discussed 120 cartons of paper cups.",
      "Someone mentioned USD 4.20 per carton last year; that was an unverified historical figure."
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": []
        },
        {
          "demand_id": "demand-2",
          "status": "unavailable",
          "evidence_ids": []
        }
      ],
      "body_scope_valid": true
    }
  },
  "RT-02:1": {
    "source_quote": "送到量度得 55 厘米。你哋容差係幾多？超出咗可以點？",
    "answer": "按你提供的尺寸，58 厘米與 55 厘米相差 3 厘米。訂造及傢俬貨品的尺寸容差為 ±2 厘米，因此超出容差 1 厘米。貨品送達後 7 日內可申請退換，須保留原包裝；仍須核對實際尺寸及退換條件。",
    "required_chunks": [
      "R-K2",
      "R-K1"
    ],
    "prior_quotes": [
      "我訂咗張書枱，網頁寫深度 58 厘米。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1",
        "E2"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        },
        {
          "demand_id": "demand-2",
          "status": "partial",
          "evidence_ids": [
            "E2"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "FB-01:0": {
    "source_quote": "我啱啱落咗單，一分鐘內就發現揀錯嘢，想取消退款。",
    "answer": "明白，你剛落單就發現選錯。餐廳未接單前可取消並全數退款；接單後不設取消。暫時未能確認餐廳是否已接單，請提供訂單編號以便核對，現時未有取消或退款成功的確認。",
    "required_chunks": [
      "F-K1"
    ],
    "prior_quotes": [],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "partial",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "FB-02:1": {
    "source_quote": "遲幾耐先有補償？我呢單計唔計？",
    "answer": "外送比預計時間遲超過 30 分鐘，可獲 HK$50 優惠券。按你所述的 20 至 30 分鐘預計時間及 70 分鐘實際時間，延遲為 40 至 50 分鐘，超過門檻。仍須核對該訂單的時間紀錄才可確認實際資格，未有發券確認。",
    "required_chunks": [
      "F-K2"
    ],
    "prior_quotes": [
      "App 寫 20 至 30 分鐘送到，我等咗 70 分鐘先收到。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        },
        {
          "demand_id": "demand-2",
          "status": "partial",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "ED-02:1": {
    "source_quote": "上咗第一堂覺得太淺，我想退學退款。可以退幾多？",
    "answer": "理解你覺得課程程度不合適。現有條款只列明開課日 7 日或之前退學，扣除 HK$500 行政費後退回餘款。你表示已上第一堂，這項條款未能確認開課後的退款安排，因此不能根據你所述約 26,500 元的付款推算實際退款。",
    "required_chunks": [
      "E-K1"
    ],
    "prior_quotes": [
      "我喺書展報咗個英文課程，一次過畀咗大約 26,500。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "partial",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "ED-03:1": {
    "source_quote": "我入學評估係第 7 級，個保證啱唔啱我用？",
    "answer": "保證達標條款只適用於入學評估達第 9 級或以上的學員。按你所述的第 7 級，未符合這項條件；實際評估紀錄仍須由校方核對。",
    "required_chunks": [
      "E-K2"
    ],
    "prior_quotes": [
      "我報咗 IELTS 保證 6 分班，第一個月學費同模擬試費各約 6,000。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "ED-05:1": {
    "source_quote": "我未開課就想取消同攞返按金。",
    "answer": "現有條款列明開課日 7 日或之前退學，扣除 HK$500 行政費後退回餘款。你表示尚未開課，但仍需知道開課日期，以及這筆 7,800 元按金是否適用該退學條款，才能確認退款金額。你原定哪天開課？",
    "required_chunks": [
      "E-K1"
    ],
    "prior_quotes": [
      "我畀咗 7,800 按金報五日課程，話完成後支票退回。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "partial",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "BE-04:1": {
    "source_quote": "分店改咗名之後話每次要 588。我張套票喺其他分店用使唔使加錢？",
    "answer": "現有條款列明套票可於本集團任何分店使用，不另收費。你所述的新收費 588 元仍需核對；如果你的套票仍有效，另一分店亦屬同一集團，按這項條款不應另收費。",
    "required_chunks": [
      "B-K3"
    ],
    "prior_quotes": [
      "我之前買咗 50 次療程，每次 100，共 5,000。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "partial",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "BE-05:2": {
    "source_quote": "等等，我講錯，係加 15。照你哋規定應唔應該加？",
    "answer": "你更正的額外收費是 15 元，不是 20 元。套票條款列明可於本集團任何分店使用，不另收費。如果剪髮券屬適用套票、仍有效，第二間分店亦屬同一集團，按條款不應加收這筆費用；仍須核對券的適用範圍。",
    "required_chunks": [
      "B-K3"
    ],
    "prior_quotes": [
      "我買咗剪髮券，每次 35。",
      "原本間分店執咗，去第二間要我加 20。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "partial",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "SA-04:2": {
    "source_quote": "咁即係減幾多個？幾時生效？",
    "answer": "按你最新更正的 110 個席位，由 200 個減至 110 個，即減少 90 個。減少用戶席位於下一個帳單周期生效，本周期已收費用不退；實際日期須核對帳單周期，現時未有變更成功的確認。",
    "required_chunks": [
      "S-K2"
    ],
    "prior_quotes": [
      "我哋而家有 200 個席位，想減到 101 個。",
      "更正：係減到 110 個，唔係 101。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": []
        },
        {
          "demand_id": "demand-2",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "WH-01:1": {
    "source_quote": "The first shipment has fewer bags than the documents say. What do we need to do, and by when?",
    "answer": "If the delivered quantity differs from the packing list, the claim must be submitted in writing within 7 days of receipt. Compare the delivered count with the packing list and include the discrepancy and receipt date in the written claim. The actual shortage and any remedy still need verification.",
    "required_chunks": [
      "W-K3"
    ],
    "prior_quotes": [
      "We ordered paper bags worth 34,000. We paid 20% in advance and another 16,000 when the first shipment left."
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "supported",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  },
  "WH-05:1": {
    "source_quote": "What late-payment interest do you apply, and what are your standard payment terms?",
    "answer": "The standard payment terms are a 30% deposit when placing the order, with the remaining balance payable before shipment. The available terms do not specify a late-payment interest rate, so I cannot confirm any interest charge on the two overdue invoices you mentioned.",
    "required_chunks": [
      "W-K2"
    ],
    "prior_quotes": [
      "我哋有兩張發票過咗期未收到款。"
    ],
    "verdict": {
      "grounded": true,
      "unsupported_claims": [],
      "evidence_chunk_ids": [
        "E1"
      ],
      "question_resolution": "partial",
      "demand_resolutions": [
        {
          "demand_id": "demand-1",
          "status": "unavailable",
          "evidence_ids": []
        },
        {
          "demand_id": "demand-2",
          "status": "supported",
          "evidence_ids": [
            "E1"
          ]
        }
      ],
      "body_scope_valid": true
    }
  }
};

function caseGeneration(row,turn,mode,kb){
 const absent={options:{answer:'',verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported'},
  proof:{status:'NOT_SUPPLIED',reason:'No model draft/reviewer fixture is supplied; empty draft and rejecting reviewer suppress hidden default answers.'}};
 if(mode!=='scripted')return absent;
 const item=observationDrafts[row.id+':'+turn];
 if(!item)return absent;
 if(row.turns[turn]!==item.source_quote||item.prior_quotes.some((q,i)=>row.turns[i]!==q))throw Error('observer_generation_source_drift:'+row.id+':'+turn);
 if(item.required_chunks.some(id=>!kb.proof.chunk_ids.includes(id)))throw Error('observer_generation_kb_scope_drift:'+row.id+':'+turn);
 const verdict=structuredClone(item.verdict);
 return {options:{answer:item.answer,verifierResponses:[verdict],verifierGrounded:false,
  verifierIds:[],verifierResolution:'unsupported'},
  proof:{status:'SCRIPTED_DRAFT_AND_REVIEWER_NOT_REAL_MODEL',source_quote:item.source_quote,
   source_quote_sha256:digest(item.source_quote),prior_quote_sha256:item.prior_quotes.map(digest),
   required_chunk_ids:item.required_chunks,source_kb_response_sha256:kb.proof.response_sha256,
   answer_sha256:digest(item.answer),reviewer_sha256:digest(verdict),
   reason:'Independently authored candidate and reviewer fixture; original runtime and B2 still decide, never a human or real-model quality verdict.'}};
}

export function buildTurnInput(row,turn,mode,fs,root){
 const proposed=mode==='scripted'||mode==='wrong_reading'?proposedReading(row,turn,mode==='wrong_reading'):{
  status:'MISSING_READING_NEGATIVE',coverage:'EMPTY_PROVIDER_READING',source_quote:row.turns[turn]};
 const kb=caseKb(row,turn,fs,root);
 const generation=caseGeneration(row,turn,mode,kb);
 const reading={...proposed,semantic_sha256:proposed.semantic?digest(proposed.semantic):null};
 delete reading.semantic;
 return {options:{originalPreview:true,fullChain:true,captureEvidence:true,handoffSetsHumanControl:true,
  // Passing originalRagResponse selects the EXISTING isolated preview permit.
  originalRagResponse:kb.response,
  ...(proposed.semantic?{semantic:proposed.semantic}:{semanticRaw:''}),
  ...generation.options},
  proof:{reading,kb:kb.proof,generation:generation.proof}};
}
