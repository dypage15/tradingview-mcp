#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Indicators;
#endregion

// ============================================================================
// MNQ Level Strategy [A/B/C]  —  NinjaTrader 8 port of the Pine v6 backtest.
// ----------------------------------------------------------------------------
// Tests three entry styles on the same level + trend + VWAP + regime framework:
//   A  Regime-adaptive : breakout when ADX = TREND, fade when ADX = RANGE
//   B  Mean-reversion  : only fade swing support/resistance
//   C  Breakout/trend  : only trade level breaks with trend + VWAP
//
// Levels = most-recent CONFIRMED swing high/low (pivot with `PivotLength` bars
// on each side). Confirmed pivots are non-repainting (they lock PivotLength
// bars after the fact), exactly like Pine's ta.pivothigh / ta.pivotlow.
//
// Risk is an ATR-based bracket (stop = ATR x mult, target = stop x reward:risk),
// submitted as native NT stop/target orders so it works live and in Strategy
// Analyzer. Set commission + slippage on your account / Strategy Analyzer for a
// realistic backtest (NinjaTrader handles those outside the script).
//
// FOR RESEARCH / BACKTESTING ONLY — not financial advice. Validate on history,
// then forward-test on SIM before risking real money.
// ============================================================================

namespace NinjaTrader.NinjaScript.Strategies
{
	public class MNQLevelStrategyABC : Strategy
	{
		// indicators
		private EMA		emaFast;
		private EMA		emaSlow;
		private ADX		adx;
		private ATR		atr;

		// persisted swing levels (equivalent to Pine `var float res / sup`)
		private double	res = double.NaN;
		private double	sup = double.NaN;

		// session-anchored VWAP accumulators
		private double	cumPV	= 0.0;
		private double	cumVol	= 0.0;
		private double	vwapVal	= double.NaN;

		// per-trade bracket distances (ticks)
		private double	stopTicks	= 0;
		private double	tpTicks		= 0;

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description					= @"MNQ Level Strategy [A/B/C] — level/regime backtest harness (Pine v6 port).";
				Name						= "MNQLevelStrategyABC";
				Calculate					= Calculate.OnBarClose;   // Pine calc_on_every_tick=false
				EntriesPerDirection			= 1;
				EntryHandling				= EntryHandling.AllEntries;
				IsExitOnSessionCloseStrategy	= false;                 // handled by FlattenAtSessionEnd
				ExitOnSessionCloseSeconds	= 30;
				IsFillLimitOnTouch			= false;
				MaximumBarsLookBack			= MaximumBarsLookBack.TwoHundredFiftySix;
				OrderFillResolution			= OrderFillResolution.Standard;
				Slippage					= 0;                     // set slippage in Strategy Analyzer / account
				StartBehavior				= StartBehavior.WaitUntilFlat;
				TimeInForce					= TimeInForce.Gtc;
				TraceOrders					= false;
				RealtimeErrorHandling		= RealtimeErrorHandling.StopCancelClose;
				StopTargetHandling			= StopTargetHandling.PerEntryExecution;
				BarsRequiredToTrade			= 20;
				IsInstantiatedOnEachOptimizationIteration = true;

				// ---- User inputs (defaults mirror the panel screenshots) ----
				EntryMode		= "C";
				PivotLength		= 3;
				EmaFastLen		= 20;
				EmaSlowLen		= 55;
				AdxLen			= 14;
				AdxThreshold	= 25;

				AtrLen			= 13;
				AtrMult			= 1.6;
				RewardRisk		= 1.0;
				Contracts		= 2;

				AllowLongs		= true;
				AllowShorts		= true;
				RestrictToSession	= true;
				SessionStart	= 930;   // HHmm, chart timezone
				SessionEnd		= 1600;  // HHmm, chart timezone
				FlattenAtSessionEnd	= false;
			}
			else if (State == State.Configure)
			{
			}
			else if (State == State.DataLoaded)
			{
				emaFast	= EMA(Close, EmaFastLen);
				emaSlow	= EMA(Close, EmaSlowLen);
				adx		= ADX(AdxLen);
				atr		= ATR(AtrLen);
			}
		}

		protected override void OnBarUpdate()
		{
			if (CurrentBar < BarsRequiredToTrade || CurrentBar < PivotLength * 2 + 1)
				return;

			// ---- Session-anchored VWAP (resets each session) ----
			if (Bars.IsFirstBarOfSession)
			{
				cumPV	= 0.0;
				cumVol	= 0.0;
			}
			double hlc3	= (High[0] + Low[0] + Close[0]) / 3.0;
			double vol	= Volume[0];
			cumPV	+= hlc3 * vol;
			cumVol	+= vol;
			vwapVal	= cumVol > 0 ? cumPV / cumVol : hlc3;

			// ---- Trend / regime ----
			bool trendUp	= emaFast[0] > emaSlow[0] && Close[0] > emaFast[0];
			bool trendDn	= emaFast[0] < emaSlow[0] && Close[0] < emaFast[0];
			bool isTrend	= adx[0] >= AdxThreshold;
			bool aboveVwap	= Close[0] > vwapVal;

			// ---- Confirmed swing levels (non-repainting; lag = PivotLength bars) ----
			double ph	= PivotHigh(PivotLength);
			double pl	= PivotLow(PivotLength);
			if (!double.IsNaN(ph)) res = ph;
			if (!double.IsNaN(pl)) sup = pl;

			// ---- Session gate ----
			bool inSess	= !RestrictToSession || InSession();

			// ---- Signals (mirror the Pine logic exactly) ----
			// Mean-reversion: tag the level and close back inside, not fighting a strong trend
			bool mrLong		= !double.IsNaN(sup) && Low[0]  <= sup && Close[0] > sup && !trendDn;
			bool mrShort	= !double.IsNaN(res) && High[0] >= res && Close[0] < res && !trendUp;

			// Breakout: close through the level with trend + VWAP agreement
			bool boLong		= !double.IsNaN(res) && Close[1] <= res && Close[0] > res && trendUp && aboveVwap;
			bool boShort	= !double.IsNaN(sup) && Close[1] >= sup && Close[0] < sup && trendDn && !aboveVwap;

			bool longSig, shortSig;
			switch (EntryMode.ToUpper())
			{
				case "B":
					longSig		= mrLong;
					shortSig	= mrShort;
					break;
				case "C":
					longSig		= boLong;
					shortSig	= boShort;
					break;
				default: // "A" regime-adaptive
					longSig		= isTrend ? boLong  : mrLong;
					shortSig	= isTrend ? boShort : mrShort;
					break;
			}

			longSig		= longSig  && AllowLongs  && inSess;
			shortSig	= shortSig && AllowShorts && inSess;

			// ---- Optional end-of-session flatten ----
			if (FlattenAtSessionEnd && RestrictToSession && !InSession() && Position.MarketPosition != MarketPosition.Flat)
			{
				if (Position.MarketPosition == MarketPosition.Long)
					ExitLong("EOD", "L");
				else
					ExitShort("EOD", "S");
				return;
			}

			// ---- Orders (enter only when flat, like the Pine `flat` guard) ----
			if (Position.MarketPosition == MarketPosition.Flat)
			{
				if (longSig)
				{
					stopTicks	= Math.Max(atr[0] * AtrMult / TickSize, 1);
					tpTicks		= stopTicks * RewardRisk;
					SetStopLoss("L", CalculationMode.Ticks, stopTicks, false);
					SetProfitTarget("L", CalculationMode.Ticks, tpTicks);
					EnterLong(Contracts, "L");
				}
				else if (shortSig)
				{
					stopTicks	= Math.Max(atr[0] * AtrMult / TickSize, 1);
					tpTicks		= stopTicks * RewardRisk;
					SetStopLoss("S", CalculationMode.Ticks, stopTicks, false);
					SetProfitTarget("S", CalculationMode.Ticks, tpTicks);
					EnterShort(Contracts, "S");
				}
			}
		}

		// ---- Confirmed pivot high: High[PivotLength] is strictly the highest of
		//      the `len` bars on each side. Returns NaN if not a pivot on this bar. ----
		private double PivotHigh(int len)
		{
			double pivot = High[len];
			for (int i = 1; i <= len; i++)
			{
				if (High[len - i] >= pivot || High[len + i] >= pivot)
					return double.NaN;
			}
			return pivot;
		}

		// ---- Confirmed pivot low: Low[PivotLength] is strictly the lowest. ----
		private double PivotLow(int len)
		{
			double pivot = Low[len];
			for (int i = 1; i <= len; i++)
			{
				if (Low[len - i] <= pivot || Low[len + i] <= pivot)
					return double.NaN;
			}
			return pivot;
		}

		// ---- Chart-timezone session window test (HHmm inclusive start, exclusive end) ----
		private bool InSession()
		{
			int t = ToTime(Time[0]) / 100;   // HHmm
			if (SessionStart <= SessionEnd)
				return t >= SessionStart && t < SessionEnd;
			// overnight window (e.g. 1700-1600 next day)
			return t >= SessionStart || t < SessionEnd;
		}

		#region Properties
		[NinjaScriptProperty]
		[Display(Name = "Entry mode (A/B/C)", Description = "A=Regime-adaptive · B=Mean-reversion · C=Breakout/trend", Order = 1, GroupName = "Mode")]
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
		[Range(1, int.MaxValue)]
		[Display(Name = "Contracts", Order = 4, GroupName = "Risk / exits")]
		public int Contracts { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Allow longs", Order = 1, GroupName = "Filters")]
		public bool AllowLongs { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Allow shorts", Order = 2, GroupName = "Filters")]
		public bool AllowShorts { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Restrict to a session", Order = 3, GroupName = "Filters")]
		public bool RestrictToSession { get; set; }

		[NinjaScriptProperty]
		[Range(0, 2359)]
		[Display(Name = "Session start (HHmm)", Order = 4, GroupName = "Filters")]
		public int SessionStart { get; set; }

		[NinjaScriptProperty]
		[Range(0, 2359)]
		[Display(Name = "Session end (HHmm)", Order = 5, GroupName = "Filters")]
		public int SessionEnd { get; set; }

		[NinjaScriptProperty]
		[Display(Name = "Flatten at session end", Order = 6, GroupName = "Filters")]
		public bool FlattenAtSessionEnd { get; set; }
		#endregion
	}
}
