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
// MNQ Auto Levels + Advisor  Ã¢â‚¬â€  NinjaTrader 8 companion indicator to the
// MNQ Level Strategy [A/B/C]. Draws the same building blocks:
//   Ã¢â‚¬Â¢ Confirmed swing support / resistance (non-repainting steplines)
//   Ã¢â‚¬Â¢ Fast / slow EMA
//   Ã¢â‚¬Â¢ Session-anchored VWAP
//   Ã¢â‚¬Â¢ A regime/mode/signal info panel (top-right)
// Plot / signal logic matches the strategy so what you see == what it trades.
// FOR RESEARCH ONLY Ã¢â‚¬â€ not financial advice.
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

		protected override void OnStateChange()
		{
			if (State == State.SetDefaults)
			{
				Description					= @"MNQ Auto Levels + Advisor Ã¢â‚¬â€ swing S/R, EMAs, session VWAP and A/B/C regime panel.";
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
				ShowPanel		= true;

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

			if (ShowPanel && IsFirstTickOfBar)
			{
				string reg		= isTrend ? "TREND" : "RANGE";
				string sig		= longSig ? "LONG setup" : shortSig ? "SHORT setup" : "Ã¢â‚¬â€";
				string txt		=  "  MNQ Level Advisor\n"
								+ "  Mode:    " + EntryMode.ToUpper() + "\n"
								+ "  Regime:  " + reg + " " + adx[0].ToString("0") + "\n"
								+ "  Trend:   " + (trendUp ? "UP" : trendDn ? "DOWN" : "flat")
									+ (aboveVwap ? " Ã‚Â· >VWAP" : " Ã‚Â· <VWAP") + "\n"
								+ "  Signal:  " + sig + " ";
				Draw.TextFixed(this, "advisorPanel", txt, TextPosition.TopRight,
					Brushes.White, new SimpleFont("Consolas", 12), Brushes.Transparent,
					Brushes.Black, 60);
			}
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

		#region Properties
		[NinjaScriptProperty]
		[Display(Name = "Entry mode", Description = "A=Regime-adaptive Ã‚Â· B=Mean-reversion Ã‚Â· C=Breakout/trend", Order = 1, GroupName = "Mode")]
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
		[Display(Name = "Show info panel", Order = 1, GroupName = "Display")]
		public bool ShowPanel { get; set; }

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
		public MNQLevelAdvisor MNQLevelAdvisor(string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, bool showPanel)
		{
			return MNQLevelAdvisor(Input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, showPanel);
		}

		public MNQLevelAdvisor MNQLevelAdvisor(ISeries<double> input, string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, bool showPanel)
		{
			if (cacheMNQLevelAdvisor != null)
				for (int idx = 0; idx < cacheMNQLevelAdvisor.Length; idx++)
					if (cacheMNQLevelAdvisor[idx] != null && cacheMNQLevelAdvisor[idx].EntryMode == entryMode && cacheMNQLevelAdvisor[idx].PivotLength == pivotLength && cacheMNQLevelAdvisor[idx].EmaFastLen == emaFastLen && cacheMNQLevelAdvisor[idx].EmaSlowLen == emaSlowLen && cacheMNQLevelAdvisor[idx].AdxLen == adxLen && cacheMNQLevelAdvisor[idx].AdxThreshold == adxThreshold && cacheMNQLevelAdvisor[idx].AtrLen == atrLen && cacheMNQLevelAdvisor[idx].ShowPanel == showPanel && cacheMNQLevelAdvisor[idx].EqualsInput(input))
						return cacheMNQLevelAdvisor[idx];
			return CacheIndicator<MNQLevelAdvisor>(new MNQLevelAdvisor(){ EntryMode = entryMode, PivotLength = pivotLength, EmaFastLen = emaFastLen, EmaSlowLen = emaSlowLen, AdxLen = adxLen, AdxThreshold = adxThreshold, AtrLen = atrLen, ShowPanel = showPanel }, input, ref cacheMNQLevelAdvisor);
		}
	}
}

namespace NinjaTrader.NinjaScript.MarketAnalyzerColumns
{
	public partial class MarketAnalyzerColumn : MarketAnalyzerColumnBase
	{
		public Indicators.MNQLevelAdvisor MNQLevelAdvisor(string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, bool showPanel)
		{
			return indicator.MNQLevelAdvisor(Input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, showPanel);
		}

		public Indicators.MNQLevelAdvisor MNQLevelAdvisor(ISeries<double> input , string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, bool showPanel)
		{
			return indicator.MNQLevelAdvisor(input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, showPanel);
		}
	}
}

namespace NinjaTrader.NinjaScript.Strategies
{
	public partial class Strategy : NinjaTrader.Gui.NinjaScript.StrategyRenderBase
	{
		public Indicators.MNQLevelAdvisor MNQLevelAdvisor(string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, bool showPanel)
		{
			return indicator.MNQLevelAdvisor(Input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, showPanel);
		}

		public Indicators.MNQLevelAdvisor MNQLevelAdvisor(ISeries<double> input , string entryMode, int pivotLength, int emaFastLen, int emaSlowLen, int adxLen, double adxThreshold, int atrLen, bool showPanel)
		{
			return indicator.MNQLevelAdvisor(input, entryMode, pivotLength, emaFastLen, emaSlowLen, adxLen, adxThreshold, atrLen, showPanel);
		}
	}
}

#endregion
