#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Xml.Serialization;
using System.Windows;
using System.Windows.Media;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.DrawingTools;
#endregion

// ============================================================================
// MNQ Auto Levels + Advisor -- NinjaTrader 8 companion indicator to the
// MNQ Level Strategy [A/B/C]. Draws the same building blocks:
//   - Confirmed swing support / resistance (non-repainting steplines)
//   - Fast / slow EMA
//   - Session-anchored VWAP
//   - A regime/mode/signal info panel (top-right)
//   - Qualifying-trade Entry / TP / SL horizontals that extend until exit
// Plot / signal logic matches the strategy so what you see == what it trades.
// FOR RESEARCH ONLY -- not financial advice.
// ============================================================================

namespace NinjaTrader.NinjaScript.Indicators
{
	public class MNQLevelAdvisor : Indicator
	{
		private EMA		emaFast;
		private EMA		emaSlow;
		private ADX		adx;
		private ATR		atr;

		private double	res = double.NaN;
		private double	sup = double.NaN;

		private double	cumPV	= 0.0;
		private double	cumVol	= 0.0;
		private double	vwapVal	= double.NaN;

		// Simulated one-at-a-time trade (mirrors strategy flat guard + ATR bracket)
		private bool	inTrade;
		private int		tDir;			// +1 long, -1 short
		private int		tEntryBar	= -1;
		private int		tExitBar	= -1;
		private double	tEntry		= double.NaN;
		private double	tStop		= double.NaN;
		private double	tTgt		= double.NaN;
		private string	tOutcome	= "";

		private readonly List<TradeRec> doneTrades = new List<TradeRec>();
		private const int MaxDoneTrades = 40;

		private struct TradeRec
		{
			public int		EntryBar;
			public int		ExitBar;
			public int		Dir;
			public double	Entry;
			public double	Stop;
			public double	Tgt;
			public string	Outcome;
		}

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description					= @"MNQ Auto Levels + Advisor - swing S/R, EMAs, session VWAP, A/B/C panel, Entry/TP/SL trade lines.";
				Name						= "MNQLevelAdvisor";
				Calculate					= Calculate.OnBarClose;
				IsOverlay					= true;
				DisplayInDataBox			= true;
				DrawOnPricePanel			= true;
				PaintPriceMarkers			= true;
				IsSuspendedWhileInactive	= true;

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
				AllowLongs		= true;
				AllowShorts		= true;
				RestrictToSession	= true;
				SessionStart	= 930;
				SessionEnd		= 1600;

				AddPlot(new Stroke(Brushes.IndianRed, 2),		PlotStyle.Hash, "Resistance");
				AddPlot(new Stroke(Brushes.SeaGreen, 2),		PlotStyle.Hash, "Support");
				AddPlot(new Stroke(Brushes.Orange, 1),			PlotStyle.Line, "EMA fast");
				AddPlot(new Stroke(Brushes.DarkOrange, 2),		PlotStyle.Line, "EMA slow");
				AddPlot(new Stroke(Brushes.DodgerBlue, 2),		PlotStyle.Line, "VWAP");
			}
			else if (State == State.DataLoaded)
			{
				emaFast	= EMA(Close, EmaFastLen);
				emaSlow	= EMA(Close, EmaSlowLen);
				adx		= ADX(AdxLen);
				atr		= ATR(AtrLen);
				inTrade		= false;
				tEntryBar	= -1;
				doneTrades.Clear();
			}
		}

		protected override void OnBarUpdate()
		{
			if (CurrentBar < PivotLength * 2 + 1 || CurrentBar < EmaSlowLen)
				return;

			// session-anchored VWAP
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

			// confirmed swing levels
			double ph	= PivotHigh(PivotLength);
			double pl	= PivotLow(PivotLength);
			if (!double.IsNaN(ph)) res = ph;
			if (!double.IsNaN(pl)) sup = pl;

			// plots
			if (!double.IsNaN(res)) Values[0][0] = res;
			if (!double.IsNaN(sup)) Values[1][0] = sup;
			Values[2][0]	= emaFast[0];
			Values[3][0]	= emaSlow[0];
			Values[4][0]	= vwapVal;

			// trend / regime / signal preview
			bool trendUp	= emaFast[0] > emaSlow[0] && Close[0] > emaFast[0];
			bool trendDn	= emaFast[0] < emaSlow[0] && Close[0] < emaFast[0];
			bool isTrend	= adx[0] >= AdxThreshold;
			bool aboveVwap	= Close[0] > vwapVal;
			bool inSess		= !RestrictToSession || InSession();

			bool mrLong		= !double.IsNaN(sup) && Low[0]  <= sup && Close[0] > sup && !trendDn;
			bool mrShort	= !double.IsNaN(res) && High[0] >= res && Close[0] < res && !trendUp;
			bool boLong		= !double.IsNaN(res) && Close[1] <= res && Close[0] > res && trendUp && aboveVwap;
			bool boShort	= !double.IsNaN(sup) && Close[1] >= sup && Close[0] < sup && trendDn && !aboveVwap;

			bool longSig, shortSig;
			switch (EntryMode.ToUpper())
			{
				case "B":	longSig = mrLong;  shortSig = mrShort;  break;
				case "C":	longSig = boLong;  shortSig = boShort;  break;
				default:	longSig = isTrend ? boLong : mrLong;  shortSig = isTrend ? boShort : mrShort;  break;
			}
			longSig		= longSig  && AllowLongs  && inSess;
			shortSig	= shortSig && AllowShorts && inSess;

			// Manage open simulated trade (exit check starts the bar AFTER entry)
			if (inTrade && CurrentBar > tEntryBar)
			{
				bool hitSl, hitTp;
				if (tDir > 0)
				{
					hitSl = Low[0]  <= tStop;
					hitTp = High[0] >= tTgt;
				}
				else
				{
					hitSl = High[0] >= tStop;
					hitTp = Low[0]  <= tTgt;
				}

				// Ambiguous bar: take SL first (conservative, matches typical stop priority)
				if (hitSl || hitTp)
				{
					tExitBar	= CurrentBar;
					tOutcome	= hitSl ? "SL" : "TP";
					ArchiveCompletedTrade();
					ClearOpenTradeDraws();
					inTrade		= false;
				}
			}

			// New entry only when flat (same as strategy)
			if (!inTrade && (longSig || shortSig))
			{
				tDir		= longSig ? 1 : -1;
				tEntry		= Close[0];
				double stopDist	= Math.Max(atr[0] * AtrMult, TickSize);
				double tpDist	= stopDist * RewardRisk;
				tStop		= tDir > 0 ? tEntry - stopDist : tEntry + stopDist;
				tTgt		= tDir > 0 ? tEntry + tpDist   : tEntry - tpDist;
				tEntryBar	= CurrentBar;
				tExitBar	= -1;
				tOutcome	= "";
				inTrade		= true;
			}

			if (ShowTradeLevels)
				DrawTradeLevels();

			if (ShowPanel && IsFirstTickOfBar)
			{
				string reg		= isTrend ? "TREND" : "RANGE";
				string sig		= longSig ? "LONG setup" : shortSig ? "SHORT setup" : "-";
				string txt		=  "  MNQ Level Advisor\n"
								+ "  Mode:    " + EntryMode.ToUpper() + "\n"
								+ "  Regime:  " + reg + " " + adx[0].ToString("0") + "\n"
								+ "  Trend:   " + (trendUp ? "UP" : trendDn ? "DOWN" : "flat")
									+ (aboveVwap ? " | >VWAP" : " | <VWAP") + "\n"
								+ "  Signal:  " + sig + "\n";
				if (inTrade)
				{
					txt += "  Pos:     " + (tDir > 0 ? "LONG" : "SHORT") + "\n"
						+  "  Entry:   " + tEntry.ToString("0.00") + "\n"
						+  "  TP:      " + tTgt.ToString("0.00") + "\n"
						+  "  SL:      " + tStop.ToString("0.00") + " ";
				}
				else if (!string.IsNullOrEmpty(tOutcome))
				{
					txt += "  Last:    " + tOutcome + " ";
				}
				else
				{
					txt += "  Pos:     flat ";
				}
				Draw.TextFixed(this, "advisorPanel", txt, TextPosition.TopRight,
					Brushes.White, new SimpleFont("Consolas", 12), Brushes.Transparent,
					Brushes.Black, 60);
			}
		}

		private void ArchiveCompletedTrade()
		{
			if (tEntryBar < 0 || tExitBar < 0)
				return;
			for (int i = 0; i < doneTrades.Count; i++)
				if (doneTrades[i].EntryBar == tEntryBar)
					return;
			doneTrades.Add(new TradeRec
			{
				EntryBar	= tEntryBar,
				ExitBar		= tExitBar,
				Dir			= tDir,
				Entry		= tEntry,
				Stop		= tStop,
				Tgt			= tTgt,
				Outcome		= tOutcome
			});
			while (doneTrades.Count > MaxDoneTrades)
				doneTrades.RemoveAt(0);
		}

		private void ClearOpenTradeDraws()
		{
			if (tEntryBar < 0)
				return;
			string sfx = "_" + tEntryBar;
			RemoveDrawObject("MNQ_en" + sfx);
			RemoveDrawObject("MNQ_tp" + sfx);
			RemoveDrawObject("MNQ_sl" + sfx);
			RemoveDrawObject("MNQ_entxt" + sfx);
			RemoveDrawObject("MNQ_tptxt" + sfx);
			RemoveDrawObject("MNQ_sltxt" + sfx);
		}

		private void DrawTradeLevels()
		{
			double atrOff = Math.Max(atr[0] * 0.15, TickSize * 4);

			// Completed trades: lines from entry -> exit, labels at exit end
			for (int i = 0; i < doneTrades.Count; i++)
			{
				TradeRec tr = doneTrades[i];
				int startAgo = CurrentBar - tr.EntryBar;
				int endAgo   = CurrentBar - tr.ExitBar;
				if (startAgo < 0 || endAgo < 0)
					continue;
				string sfx = "_d" + tr.EntryBar;
				Brush enBrush = tr.Dir > 0 ? Brushes.LimeGreen : Brushes.OrangeRed;
				Brush slBrush = tr.Outcome == "SL" ? Brushes.Red : Brushes.MediumPurple;
				Brush tpBrush = tr.Outcome == "TP" ? Brushes.Lime : Brushes.DodgerBlue;

				Draw.Line(this, "MNQ_den" + sfx, false, startAgo, tr.Entry, endAgo, tr.Entry, enBrush, DashStyleHelper.Solid, 2);
				Draw.Line(this, "MNQ_dtp" + sfx, false, startAgo, tr.Tgt,   endAgo, tr.Tgt,   tpBrush, DashStyleHelper.Dash, 2);
				Draw.Line(this, "MNQ_dsl" + sfx, false, startAgo, tr.Stop,  endAgo, tr.Stop,  slBrush, DashStyleHelper.Dot, 1);

				Draw.Text(this, "MNQ_dtpt" + sfx, "TP " + tr.Tgt.ToString("0.00"), endAgo, tr.Tgt + atrOff, tpBrush);
				Draw.Text(this, "MNQ_dent" + sfx, "Entry " + tr.Entry.ToString("0.00") + " [" + tr.Outcome + "]",
					endAgo, tr.Entry, enBrush);
				Draw.Text(this, "MNQ_dslt" + sfx, "SL " + tr.Stop.ToString("0.00"), endAgo, tr.Stop - atrOff, slBrush);
			}

			// Open trade: lines extend to current bar; labels at the live end
			if (!inTrade || tEntryBar < 0)
				return;

			string osfx = "_" + tEntryBar;
			int oStart = CurrentBar - tEntryBar;
			int oEnd   = 0;
			Brush oEn  = tDir > 0 ? Brushes.LimeGreen : Brushes.OrangeRed;

			Draw.Line(this, "MNQ_en" + osfx, false, oStart, tEntry, oEnd, tEntry, oEn, DashStyleHelper.Solid, 2);
			Draw.Line(this, "MNQ_tp" + osfx, false, oStart, tTgt,   oEnd, tTgt,   Brushes.DodgerBlue, DashStyleHelper.Dash, 2);
			Draw.Line(this, "MNQ_sl" + osfx, false, oStart, tStop,  oEnd, tStop,  Brushes.MediumPurple, DashStyleHelper.Dot, 1);

			Draw.Text(this, "MNQ_tptxt" + osfx, "TP " + tTgt.ToString("0.00"), oEnd, tTgt + atrOff, Brushes.DodgerBlue);
			Draw.Text(this, "MNQ_entxt" + osfx, "Entry " + tEntry.ToString("0.00"), oEnd, tEntry, oEn);
			Draw.Text(this, "MNQ_sltxt" + osfx, "SL " + tStop.ToString("0.00"), oEnd, tStop - atrOff, Brushes.MediumPurple);
		}

		private double PivotHigh(int len)
		{
			double pivot = High[len];
			for (int i = 1; i <= len; i++)
				if (High[len - i] >= pivot || High[len + i] >= pivot) return double.NaN;
			return pivot;
		}

		private double PivotLow(int len)
		{
			double pivot = Low[len];
			for (int i = 1; i <= len; i++)
				if (Low[len - i] <= pivot || Low[len + i] <= pivot) return double.NaN;
			return pivot;
		}

		private bool InSession()
		{
			int t = ToTime(Time[0]) / 100;
			if (SessionStart <= SessionEnd)
				return t >= SessionStart && t < SessionEnd;
			return t >= SessionStart || t < SessionEnd;
		}

		#region Properties
		[NinjaScriptProperty]
		[Display(Name = "Entry mode", Description = "A=Regime-adaptive | B=Mean-reversion | C=Breakout/trend", Order = 1, GroupName = "Mode")]
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

		[Display(Name = "Allow longs", Order = 1, GroupName = "Filters")]
		public bool AllowLongs { get; set; }

		[Display(Name = "Allow shorts", Order = 2, GroupName = "Filters")]
		public bool AllowShorts { get; set; }

		[Display(Name = "Restrict to a session", Order = 3, GroupName = "Filters")]
		public bool RestrictToSession { get; set; }

		[Range(0, 2359)]
		[Display(Name = "Session start (HHmm)", Order = 4, GroupName = "Filters")]
		public int SessionStart { get; set; }

		[Range(0, 2359)]
		[Display(Name = "Session end (HHmm)", Order = 5, GroupName = "Filters")]
		public int SessionEnd { get; set; }

		[Browsable(false)]
		[XmlIgnore]
		public Series<double> Resistance => Values[0];
		[Browsable(false)]
		[XmlIgnore]
		public Series<double> Support => Values[1];
		#endregion
	}
}


#region NinjaScript generated code. Neither change nor remove.

namespace NinjaTrader.NinjaScript.Indicators
{
	public partial class Indicator : NinjaTrader.Gui.NinjaScript.IndicatorRenderBase
	{
		private MNQLevelAdvisor[] cacheMNQLevelAdvisor;
		public MNQLevelAdvisor MNQLevelAdvisor(string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, double atrMult, double rewardRisk, bool showPanel, bool showTradeLevels)
		{
			return MNQLevelAdvisor(Input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, atrMult, rewardRisk, showPanel, showTradeLevels);
		}

		public MNQLevelAdvisor MNQLevelAdvisor(ISeries<double> input, string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, double atrMult, double rewardRisk, bool showPanel, bool showTradeLevels)
		{
			if (cacheMNQLevelAdvisor != null)
				for (int idx = 0; idx < cacheMNQLevelAdvisor.Length; idx++)
					if (cacheMNQLevelAdvisor[idx] != null && cacheMNQLevelAdvisor[idx].EntryMode == entryMode && cacheMNQLevelAdvisor[idx].PivotLength == pivotLength && cacheMNQLevelAdvisor[idx].EmaFastLen == emaFastLen && cacheMNQLevelAdvisor[idx].EmaSlowLen == emaSlowLen && cacheMNQLevelAdvisor[idx].AdxLen == adxLen && cacheMNQLevelAdvisor[idx].AdxThreshold == adxThreshold && cacheMNQLevelAdvisor[idx].AtrLen == atrLen && cacheMNQLevelAdvisor[idx].AtrMult == atrMult && cacheMNQLevelAdvisor[idx].RewardRisk == rewardRisk && cacheMNQLevelAdvisor[idx].ShowPanel == showPanel && cacheMNQLevelAdvisor[idx].ShowTradeLevels == showTradeLevels && cacheMNQLevelAdvisor[idx].EqualsInput(input))
						return cacheMNQLevelAdvisor[idx];
			return CacheIndicator<MNQLevelAdvisor>(new MNQLevelAdvisor(){ EntryMode = entryMode, PivotLength = pivotLength, EmaFastLen = emaFastLen, EmaSlowLen = emaSlowLen, AdxLen = adxLen, AdxThreshold = adxThreshold, AtrLen = atrLen, AtrMult = atrMult, RewardRisk = rewardRisk, ShowPanel = showPanel, ShowTradeLevels = showTradeLevels }, input, ref cacheMNQLevelAdvisor);
		}
	}
}

namespace NinjaTrader.NinjaScript.MarketAnalyzerColumns
{
	public partial class MarketAnalyzerColumn : MarketAnalyzerColumnBase
	{
		public Indicators.MNQLevelAdvisor MNQLevelAdvisor(string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, double atrMult, double rewardRisk, bool showPanel, bool showTradeLevels)
		{
			return indicator.MNQLevelAdvisor(Input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, atrMult, rewardRisk, showPanel, showTradeLevels);
		}

		public Indicators.MNQLevelAdvisor MNQLevelAdvisor(ISeries<double> input , string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, double atrMult, double rewardRisk, bool showPanel, bool showTradeLevels)
		{
			return indicator.MNQLevelAdvisor(input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, atrMult, rewardRisk, showPanel, showTradeLevels);
		}
	}
}

namespace NinjaTrader.NinjaScript.Strategies
{
	public partial class Strategy : NinjaTrader.Gui.NinjaScript.StrategyRenderBase
	{
		public Indicators.MNQLevelAdvisor MNQLevelAdvisor(string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, double atrMult, double rewardRisk, bool showPanel, bool showTradeLevels)
		{
			return indicator.MNQLevelAdvisor(Input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, atrMult, rewardRisk, showPanel, showTradeLevels);
		}

		public Indicators.MNQLevelAdvisor MNQLevelAdvisor(ISeries<double> input , string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, double atrMult, double rewardRisk, bool showPanel, bool showTradeLevels)
		{
			return indicator.MNQLevelAdvisor(input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, atrMult, rewardRisk, showPanel, showTradeLevels);
		}
	}
}

#endregion
