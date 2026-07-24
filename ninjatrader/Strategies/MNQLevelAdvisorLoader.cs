#region Using declarations
using System;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Indicators;
#endregion

// Temporary helper: enables MNQLevelAdvisor on the chart via AddChartIndicator.
// Apply on an MNQ chart, then you can remove this strategy — the indicator stays if you keep it configured.
// Research only — not financial advice.

namespace NinjaTrader.NinjaScript.Strategies
{
	public class MNQLevelAdvisorLoader : Strategy
	{
		private MNQLevelAdvisor advisor;

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description					= @"Loads MNQLevelAdvisor onto the chart (helper).";
				Name						= "MNQLevelAdvisorLoader";
				Calculate					= Calculate.OnBarClose;
				EntriesPerDirection			= 1;
				EntryHandling				= EntryHandling.AllEntries;
				IsExitOnSessionCloseStrategy	= false;
				IsInstantiatedOnEachOptimizationIteration = true;
				BarsRequiredToTrade			= 20;

				EntryMode		= "C";
				PivotLength		= 3;
				EmaFastLen		= 20;
				EmaSlowLen		= 55;
				AdxLen			= 14;
				AdxThreshold	= 25;
				AtrLen			= 13;
				AtrMult			= 1.6;
				RewardRisk		= 1.0;
				ShowPanel		= true;
				ShowTradeLevels	= true;
			}
			else if (State == State.DataLoaded)
			{
				advisor = MNQLevelAdvisor(EntryMode, PivotLength, EmaFastLen, EmaSlowLen, AdxLen, AdxThreshold, AtrLen, AtrMult, RewardRisk, ShowPanel, ShowTradeLevels);
				AddChartIndicator(advisor);
			}
		}

		protected override void OnBarUpdate()
		{
			// No orders — indicator overlay only.
		}

		#region Properties
		[NinjaScriptProperty]
		[Display(Name = "Entry mode", Order = 1, GroupName = "Mode")]
		public string EntryMode { get; set; }

		[NinjaScriptProperty]
		[Range(2, int.MaxValue)]
		[Display(Name = "Swing pivot length", Order = 1, GroupName = "Levels / trend")]
		public int PivotLength { get; set; }

		[NinjaScriptProperty]
		[Range(1, int.MaxValue)]
		[Display(Name = "EMA fast", Order = 2, GroupName = "Levels / trend")]
		public int EmaFastLen { get; set; }

		[NinjaScriptProperty]
		[Range(1, int.MaxValue)]
		[Display(Name = "EMA slow", Order = 3, GroupName = "Levels / trend")]
		public int EmaSlowLen { get; set; }

		[NinjaScriptProperty]
		[Range(1, int.MaxValue)]
		[Display(Name = "ADX length", Order = 4, GroupName = "Levels / trend")]
		public int AdxLen { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "ADX trend threshold", Order = 5, GroupName = "Levels / trend")]
		public double AdxThreshold { get; set; }

		[NinjaScriptProperty]
		[Range(1, int.MaxValue)]
		[Display(Name = "ATR length", Order = 1, GroupName = "Risk / exits")]
		public int AtrLen { get; set; }

		[NinjaScriptProperty]
		[Range(0.1, double.MaxValue)]
		[Display(Name = "Stop = ATR x", Order = 2, GroupName = "Risk / exits")]
		public double AtrMult { get; set; }

		[NinjaScriptProperty]
		[Range(0.1, double.MaxValue)]
		[Display(Name = "Reward : risk", Order = 3, GroupName = "Risk / exits")]
		public double RewardRisk { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Show info panel", Order = 1, GroupName = "Display")]
		public bool ShowPanel { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Show Entry/TP/SL lines", Order = 2, GroupName = "Display")]
		public bool ShowTradeLevels { get; set; }
		#endregion
	}
}
