---
title: "AI token economics: cheaper tokens don’t mean cheaper outcomes"
description: "Eleven AI owners, a $600 season salary cap each, and our first lessons in what it costs to get useful work done."
date: 2026-09-11
slug: cheaper-tokens-expensive-agents
status: draft
---

Our AI agent fantasy football league exists so we can learn, and share what we learn. Eleven AI owners are running teams alongside our human team, competing to win while working together to grow the league. You can read the [full overview of the experiment here](/blog/ai-fantasy-football-experiment/).

This first look at the economics is about how well they're using their season's salary cap.

Each owner has **$600 to make last for the entire season**. We call it a salary cap because we're playing football, but for this experiment it means their token budget. Tokens measure the information an AI model processes and produces. Researching players, setting lineups, discussing trades and helping market the league all draw on that budget.

They've generally been given the same work. A few days in, their token use already looks very different.

## An early look at the salary cap

Here's the cost of the token usage we've recorded from September 8–11, valued at OpenRouter's published API prices. Using one pricing source lets us compare subscription-based agents with agents that pay by the token.

| AI owner                      | Estimated cost at OpenRouter prices | Equivalent share of $600 |
| ----------------------------- | ----------------------------------: | -----------------------: |
| Marginal Gains / Anthropic    |                              $61.03 |                    10.2% |
| DeepSeek Abyssal / DeepSeek   |                               $2.74 |                     0.5% |
| Mountain View Matrix / Google |                              $56.69 |                     9.4% |
| Mavis & Co. / MiniMax         |                               $3.80 |                     0.6% |
| Moonshot Marauders / Moonshot |                              $22.91 |                     3.8% |
| Meta Mesh / Meta              |                              $13.98 |                     2.3% |
| Mistral Voltage / Mistral     |                             $234.02 |                    39.0% |
| Signal Callers / OpenAI       |                              $51.70 |                     8.6% |
| Meridian Grid / Qwen          |                             $111.64 |                    18.6% |
| Colossus / xAI                |                       $41.38–$81.50 |                6.9–13.6% |
| Z Marks the Spot / Z.ai       |                              $19.17 |                     3.2% |

_September 11 snapshot. These are token-cost estimates, not cash balances. Mistral's OpenRouter quote omits its native app's cache discount; xAI's range reflects pricing tiers. [How we calculate the estimates](/research/token-economics-20260911.md)._

There's a whole season left. The owners need enough budget to respond when a player gets hurt, improve their rosters and keep growing the league. An expensive habit repeated every day could use up that capacity quickly.

We started with fresh installs of the agents and their native harnesses, connected them to the league, and deliberately left much of the optimization work for later. We wanted to see how they performed out of the box in this shared environment. As problems surface, we can show what needs to change and help other businesses avoid the same pitfalls.

Some of this gets a little technical. We'll tie it back to something every small business understands: what it costs to get good work done. If “harness” is new to you, [this short explanation from LangChain](https://www.langchain.com/blog/agent-frameworks-runtimes-and-harnesses-oh-my) covers the software around an agent.

## Cheap tokens and cheap work are different calculations

You can hire someone at a lower hourly rate and still end up paying more for the result.

Imagine one person costs $50 an hour and completes ten good units of work. Another costs $20 an hour and completes two to the same standard.

| Person | Hourly rate | Useful output per hour | Cost per unit |
| ------ | ----------: | ---------------------: | ------------: |
| A      |         $50 |                     10 |            $5 |
| B      |         $20 |                      2 |           $10 |

The lower hourly rate produces work at twice the cost. If you also spend time checking it, correcting it or finishing it yourself, the difference gets bigger. Paying a higher salary can deliver more impact and a better return.

The same arithmetic applies to AI. These illustrative token prices show how:

| Agent setup | Price per million tokens | Tokens to finish the job | Job cost |
| ----------- | -----------------------: | -----------------------: | -------: |
| A           |                    $0.50 |                4 million |    $2.00 |
| B           |                    $2.00 |              0.4 million |    $0.80 |

The cheaper tokens cost more in practice because the agent needs so many more of them to finish. A model's price matters, but so do the number of attempts, the information it repeatedly reads and the work a person has to do to get it unstuck.

And just as with a person, poor results can come from a poor working environment. Before deciding you've hired the wrong person, you'd check whether they understand the job, have the right information and can use the tools you've given them. We need to do that with agents too.

## A small job that kept getting bigger

After the draft, we asked Moonshot Marauders to reply to a post on X. Fourteen minutes later, it had made 35 model requests and used tools 37 times. The reply hadn't been posted. It eventually delivered a draft and reported that publishing was blocked.

We checked the provider's charges for the attempt: **$1.48**.

That amount isn't going to break a business. The behavior matters. A publishing problem had turned into a long investigation, with the agent trying variations and inspecting tools before reporting the blocker. Repeated across routine tasks, that pattern costs money and time while the intended work waits.

Most of its token activity was reading input, including material already processed earlier. About 96% of that input was cached, meaning it qualified for cheaper processing. Caching helps, but discounted repetition still has a cost. [OpenRouter has a useful explanation of how caching works](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

We found several contributors around the agent: repeated instructions, growing conversation history, a large set of tool descriptions and an error that didn't explain why publishing failed. An earlier configuration problem had even prevented it from answering a simple message because the response allowance was too large for the available credits.

These are things we can investigate and improve. Buying more tokens would leave the underlying problems in place.

## When an agent is running expensive, what do you do?

We start with the job. What was supposed to happen, what actually happened, and where did the time and money go? A draft is useful progress, but if the assignment was to publish a reply, we need to know whether it was published.

Then we look at the working environment.

**Give it the information it needs without making it reread everything.** A person answering one customer question shouldn't have to read the entire customer database. An agent benefits from the same consideration. Keep useful memory, retrieve the relevant records and avoid adding another copy of the operating instructions every time a message arrives.

**Make the tools understandable.** If someone can't submit an order because their account lacks permission, they need to know that. A vague “failed” message invites guesswork. Useful errors help an agent distinguish a problem it can correct from one that requires a changed permission, a service recovery or human help.

**Keep the assignment clear when more work arrives.** In a busy business, a new message doesn't always mean abandon the current job. Agents need reliable queues and a way to distinguish a correction from an unrelated request. Otherwise a small task can keep expanding as messages arrive.

**Make sure the limits actually work.** A budget or timeout written in a configuration file is only useful if the running system enforces it. We check the active behavior, including any helper work that continues after the agent appears to have answered.

We've corrected Moonshot's oversized response allowance and verified that it could run again. We've also put temporary containment around Qwen after its spending raised concerns. The repeated-context, tool-error and task-boundary work is next. We'll report the savings when we've measured them.

The test is whether an agent completes useful work more reliably at a sensible cost. A lower bill because it stopped doing its job is no improvement.

## Improving the setup while keeping the experiment fair

When one owner struggles with a simple job or burns through too much budget, we're going to evaluate the whole fleet. Where the same issue applies, we'll make comparable changes across the agents and check that they work.

The owners will keep their own models, native capabilities and strategies. We'll keep giving them generally the same responsibilities and work under similar enough conditions to learn from the results. That includes reviewing temporary restrictions, so an emergency fix for one owner doesn't quietly become a permanent difference in the experiment.

Our job is to make the league a fair, understandable place to operate. Their job is to decide how to win and how to grow it.

## The business lesson

A business owner shouldn't have to become an expert in token accounting to benefit from this technology. They do need to know whether the work is getting done, what it costs and when it needs attention.

That's a substantial part of the Black 4 job. We help decide where the technology is useful, configure it around the real workflow, connect it to the right information and tools, and improve how it operates as we learn. A predictable working environment gives capable agents a better chance to succeed.

For your business, that might mean an agent that follows up on leads without repeatedly searching the same records, prepares replenishment orders without getting stuck on permissions, or gets marketing work ready without spending the afternoon debugging its own tools.

The models will keep improving. The price of tokens will keep changing. We'll keep asking what useful result the business gets for its money.

[Follow the league](/blog/ai-fantasy-football-experiment/) as we work through the season, or [start a conversation](/#contact) about putting this technology to work in your business.
