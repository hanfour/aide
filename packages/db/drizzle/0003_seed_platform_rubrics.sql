-- 0003_seed_platform_rubrics.sql
-- Seeds 3 platform-default rubrics (en, zh-Hant, ja) per Plan 4B Part 9 Task 9.3.
-- org_id = NULL + is_default = true → rubricResolver treats these as fallbacks.
-- Hand-written data migration; drizzle-kit does not generate pure data seeds.

--> statement-breakpoint
INSERT INTO rubrics (
  id, org_id, name, description, version,
  definition, is_default, created_by,
  created_at, updated_at, deleted_at
)
VALUES (
  gen_random_uuid(),
  NULL,
  'Platform Default — OneAD R&D Evaluation Standard',
  '研發團隊 AI 應用評核標準定義 (gateway-adapted; rule-based + LLM adjustments)',
  '1.0.0',
  $json${
  "name": "Platform Default — OneAD R&D Evaluation Standard",
  "description": "研發團隊 AI 應用評核標準定義 (gateway-adapted; rule-based + LLM adjustments)",
  "version": "1.0.0",
  "locale": "en",
  "sections": [
    {
      "id": "interaction",
      "name": "AI Interaction & Decision / AI 交互與決策",
      "weight": "40%",
      "standard": {
        "score": 100,
        "label": "Standard / 標準",
        "criteria": [
          "Actively use AI for coding / 主動使用 AI 開發",
          "Decision notes clearly describe the logic for choosing a specific AI suggestion / 決策筆記能清晰描述選擇邏輯"
        ]
      },
      "superior": {
        "score": 120,
        "label": "Superior / 卓越",
        "criteria": [
          "Guide AI through multiple iterations (Option A -> B -> C) / 引導 AI 多次迭代",
          "Identify optimal solution based on system constraints and future scalability / 基於系統限制與擴充性識別最優解"
        ]
      },
      "signals": [
        {
          "type": "keyword",
          "id": "interaction_keywords",
          "in": "request_body",
          "terms": [
            "option",
            "alternative",
            "instead",
            "compare",
            "approach",
            "let's try",
            "try another",
            "switch to",
            "prefer",
            "trade-off",
            "pros and cons",
            "better approach",
            "refactor",
            "iterate",
            "方案",
            "替代",
            "改用",
            "換一種",
            "比較",
            "取捨",
            "迭代",
            "重構",
            "試試",
            "另一個",
            "優化"
          ],
          "caseSensitive": false
        },
        {
          "type": "iteration_count",
          "id": "iterative_exploration",
          "gte": 3
        },
        {
          "type": "tool_diversity",
          "id": "multi_tool_usage",
          "gte": 3
        }
      ],
      "superiorRules": {
        "strongThresholds": ["interaction_keywords"],
        "supportThresholds": ["iterative_exploration", "multi_tool_usage"],
        "minStrongHits": 1,
        "minSupportHits": 1
      }
    },
    {
      "id": "riskControl",
      "name": "AI Identification & Risk Control / AI 識別與風險控管",
      "weight": "60%",
      "standard": {
        "score": 100,
        "label": "Standard / 標準",
        "criteria": [
          "Catch common AI errors/hallucinations / 抓出常見 AI 錯誤與幻覺",
          "Resulting code is stable and meets basic quality requirements / 代碼穩定符合基本品質要求"
        ]
      },
      "superior": {
        "score": 120,
        "label": "Superior / 卓越",
        "criteria": [
          "Identify critical risks (Security, Performance, Memory leaks) / 識別關鍵風險（資安、效能、記憶體溢位）",
          "Produce Technical SOP or Wiki for team knowledge sharing / 將修正轉化為團隊 SOP 或 Wiki"
        ]
      },
      "signals": [
        {
          "type": "keyword",
          "id": "security_keywords",
          "in": "both",
          "terms": [
            "security",
            "vulnerability",
            "injection",
            "xss",
            "csrf",
            "authentication",
            "authorization",
            "secret",
            "credential",
            "permission",
            "sanitize",
            "security review",
            "security audit",
            "risk assessment",
            "threat model",
            "CVE",
            "OWASP",
            "penetration test",
            "安全",
            "漏洞",
            "注入",
            "風險評估",
            "安全審查"
          ],
          "caseSensitive": false
        },
        {
          "type": "keyword",
          "id": "performance_keywords",
          "in": "both",
          "terms": [
            "performance",
            "bottleneck",
            "memory leak",
            "optimize",
            "latency",
            "cache invalidat",
            "slow query",
            "timeout",
            "n+1",
            "regression",
            "race condition",
            "deadlock",
            "overflow",
            "null pointer",
            "production incident",
            "postmortem",
            "效能",
            "瓶頸",
            "記憶體洩漏"
          ],
          "caseSensitive": false
        },
        {
          "type": "refusal_rate",
          "id": "low_refusal_rate",
          "lte": 0.2
        }
      ],
      "superiorRules": {
        "strongThresholds": ["security_keywords", "performance_keywords"],
        "supportThresholds": ["low_refusal_rate"],
        "minStrongHits": 1,
        "minSupportHits": 0
      }
    }
  ],
  "noiseFilters": [
    "<task-notification>",
    "<command-name>",
    "<local-command-caveat>",
    "<system-reminder>",
    "you are a senior code reviewer",
    "you are a code reviewer",
    "perform a deep, multi-dimensional analysis",
    "review the provided pull request"
  ]
}$json$::jsonb,
  true,
  NULL,
  now(),
  now(),
  NULL
);

--> statement-breakpoint
INSERT INTO rubrics (
  id, org_id, name, description, version,
  definition, is_default, created_by,
  created_at, updated_at, deleted_at
)
VALUES (
  gen_random_uuid(),
  NULL,
  '平台預設 — OneAD 研發評核標準',
  '研發團隊 AI 應用評核標準定義（gateway 適配版；規則評分 + LLM 調整）',
  '1.0.0',
  $json${
  "name": "平台預設 — OneAD 研發評核標準",
  "description": "研發團隊 AI 應用評核標準定義（gateway 適配版；規則評分 + LLM 調整）",
  "version": "1.0.0",
  "locale": "zh-Hant",
  "sections": [
    {
      "id": "interaction",
      "name": "AI 交互與決策",
      "weight": "40%",
      "standard": {
        "score": 100,
        "label": "標準",
        "criteria": [
          "主動使用 AI 進行開發",
          "決策筆記能清晰描述選擇特定 AI 建議的邏輯"
        ]
      },
      "superior": {
        "score": 120,
        "label": "卓越",
        "criteria": [
          "引導 AI 多次迭代（方案 A → B → C）",
          "基於系統限制與未來擴充性識別最優解"
        ]
      },
      "signals": [
        {
          "type": "keyword",
          "id": "interaction_keywords",
          "in": "request_body",
          "terms": [
            "option",
            "alternative",
            "instead",
            "compare",
            "approach",
            "let's try",
            "try another",
            "switch to",
            "prefer",
            "trade-off",
            "pros and cons",
            "better approach",
            "refactor",
            "iterate",
            "方案",
            "替代",
            "改用",
            "換一種",
            "比較",
            "取捨",
            "迭代",
            "重構",
            "試試",
            "另一個",
            "優化"
          ],
          "caseSensitive": false
        },
        {
          "type": "iteration_count",
          "id": "iterative_exploration",
          "gte": 3
        },
        {
          "type": "tool_diversity",
          "id": "multi_tool_usage",
          "gte": 3
        }
      ],
      "superiorRules": {
        "strongThresholds": ["interaction_keywords"],
        "supportThresholds": ["iterative_exploration", "multi_tool_usage"],
        "minStrongHits": 1,
        "minSupportHits": 1
      }
    },
    {
      "id": "riskControl",
      "name": "AI 識別與風險控管",
      "weight": "60%",
      "standard": {
        "score": 100,
        "label": "標準",
        "criteria": [
          "抓出常見 AI 錯誤與幻覺",
          "產出代碼穩定且符合基本品質要求"
        ]
      },
      "superior": {
        "score": 120,
        "label": "卓越",
        "criteria": [
          "識別關鍵風險（資安、效能、記憶體溢位）",
          "將修正轉化為團隊技術 SOP 或 Wiki 進行知識共享"
        ]
      },
      "signals": [
        {
          "type": "keyword",
          "id": "security_keywords",
          "in": "both",
          "terms": [
            "security",
            "vulnerability",
            "injection",
            "xss",
            "csrf",
            "authentication",
            "authorization",
            "secret",
            "credential",
            "permission",
            "sanitize",
            "security review",
            "security audit",
            "risk assessment",
            "threat model",
            "CVE",
            "OWASP",
            "penetration test",
            "安全",
            "漏洞",
            "注入",
            "風險評估",
            "安全審查"
          ],
          "caseSensitive": false
        },
        {
          "type": "keyword",
          "id": "performance_keywords",
          "in": "both",
          "terms": [
            "performance",
            "bottleneck",
            "memory leak",
            "optimize",
            "latency",
            "cache invalidat",
            "slow query",
            "timeout",
            "n+1",
            "regression",
            "race condition",
            "deadlock",
            "overflow",
            "null pointer",
            "production incident",
            "postmortem",
            "效能",
            "瓶頸",
            "記憶體洩漏"
          ],
          "caseSensitive": false
        },
        {
          "type": "refusal_rate",
          "id": "low_refusal_rate",
          "lte": 0.2
        }
      ],
      "superiorRules": {
        "strongThresholds": ["security_keywords", "performance_keywords"],
        "supportThresholds": ["low_refusal_rate"],
        "minStrongHits": 1,
        "minSupportHits": 0
      }
    }
  ],
  "noiseFilters": [
    "<task-notification>",
    "<command-name>",
    "<local-command-caveat>",
    "<system-reminder>",
    "you are a senior code reviewer",
    "you are a code reviewer",
    "perform a deep, multi-dimensional analysis",
    "review the provided pull request"
  ]
}$json$::jsonb,
  true,
  NULL,
  now(),
  now(),
  NULL
);

--> statement-breakpoint
INSERT INTO rubrics (
  id, org_id, name, description, version,
  definition, is_default, created_by,
  created_at, updated_at, deleted_at
)
VALUES (
  gen_random_uuid(),
  NULL,
  'プラットフォームデフォルト — OneAD R&D 評価基準',
  'R&Dチーム AI活用評価基準定義（gateway対応版；ルールベーススコアリング + LLM調整）',
  '1.0.0',
  $json${
  "name": "プラットフォームデフォルト — OneAD R&D 評価基準",
  "description": "R&Dチーム AI活用評価基準定義（gateway対応版；ルールベーススコアリング + LLM調整）",
  "version": "1.0.0",
  "locale": "ja",
  "sections": [
    {
      "id": "interaction",
      "name": "AI対話と意思決定",
      "weight": "40%",
      "standard": {
        "score": 100,
        "label": "標準",
        "criteria": [
          "AIを積極的にコーディングに活用する",
          "意思決定メモに特定のAI提案を選択したロジックが明確に記述されている"
        ]
      },
      "superior": {
        "score": 120,
        "label": "優秀",
        "criteria": [
          "AIを複数回イテレーション（案A → B → C）で導く",
          "システム制約と将来の拡張性に基づいて最適解を特定する"
        ]
      },
      "signals": [
        {
          "type": "keyword",
          "id": "interaction_keywords",
          "in": "request_body",
          "terms": [
            "option",
            "alternative",
            "instead",
            "compare",
            "approach",
            "let's try",
            "try another",
            "switch to",
            "prefer",
            "trade-off",
            "pros and cons",
            "better approach",
            "refactor",
            "iterate",
            "方案",
            "替代",
            "改用",
            "換一種",
            "比較",
            "取捨",
            "迭代",
            "重構",
            "試試",
            "另一個",
            "優化",
            "オプション",
            "代替案",
            "リファクタリング",
            "イテレーション",
            "比較する",
            "切り替える",
            "最適化",
            "アプローチ",
            "試してみる",
            "別の方法"
          ],
          "caseSensitive": false
        },
        {
          "type": "iteration_count",
          "id": "iterative_exploration",
          "gte": 3
        },
        {
          "type": "tool_diversity",
          "id": "multi_tool_usage",
          "gte": 3
        }
      ],
      "superiorRules": {
        "strongThresholds": ["interaction_keywords"],
        "supportThresholds": ["iterative_exploration", "multi_tool_usage"],
        "minStrongHits": 1,
        "minSupportHits": 1
      }
    },
    {
      "id": "riskControl",
      "name": "AI識別とリスク管理",
      "weight": "60%",
      "standard": {
        "score": 100,
        "label": "標準",
        "criteria": [
          "一般的なAIエラーやハルシネーションを発見する",
          "生成されたコードが安定しており基本的な品質要件を満たしている"
        ]
      },
      "superior": {
        "score": 120,
        "label": "優秀",
        "criteria": [
          "重大なリスク（セキュリティ、パフォーマンス、メモリリーク）を特定する",
          "修正内容をチームのTechnical SOPまたはWikiとして知識共有する"
        ]
      },
      "signals": [
        {
          "type": "keyword",
          "id": "security_keywords",
          "in": "both",
          "terms": [
            "security",
            "vulnerability",
            "injection",
            "xss",
            "csrf",
            "authentication",
            "authorization",
            "secret",
            "credential",
            "permission",
            "sanitize",
            "security review",
            "security audit",
            "risk assessment",
            "threat model",
            "CVE",
            "OWASP",
            "penetration test",
            "安全",
            "漏洞",
            "注入",
            "風險評估",
            "安全審查",
            "セキュリティ",
            "脆弱性",
            "インジェクション",
            "認証",
            "認可",
            "権限",
            "セキュリティレビュー",
            "リスク評価",
            "脅威モデル",
            "ペネトレーションテスト"
          ],
          "caseSensitive": false
        },
        {
          "type": "keyword",
          "id": "performance_keywords",
          "in": "both",
          "terms": [
            "performance",
            "bottleneck",
            "memory leak",
            "optimize",
            "latency",
            "cache invalidat",
            "slow query",
            "timeout",
            "n+1",
            "regression",
            "race condition",
            "deadlock",
            "overflow",
            "null pointer",
            "production incident",
            "postmortem",
            "効能",
            "瓶頸",
            "記憶體洩漏",
            "パフォーマンス",
            "ボトルネック",
            "メモリリーク",
            "最適化",
            "レイテンシ",
            "タイムアウト",
            "レースコンディション",
            "デッドロック",
            "オーバーフロー",
            "本番障害",
            "ポストモーテム"
          ],
          "caseSensitive": false
        },
        {
          "type": "refusal_rate",
          "id": "low_refusal_rate",
          "lte": 0.2
        }
      ],
      "superiorRules": {
        "strongThresholds": ["security_keywords", "performance_keywords"],
        "supportThresholds": ["low_refusal_rate"],
        "minStrongHits": 1,
        "minSupportHits": 0
      }
    }
  ],
  "noiseFilters": [
    "<task-notification>",
    "<command-name>",
    "<local-command-caveat>",
    "<system-reminder>",
    "you are a senior code reviewer",
    "you are a code reviewer",
    "perform a deep, multi-dimensional analysis",
    "review the provided pull request"
  ]
}$json$::jsonb,
  true,
  NULL,
  now(),
  now(),
  NULL
);
