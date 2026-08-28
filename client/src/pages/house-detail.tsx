import { useState, useEffect, useMemo, type ReactElement } from "react";
import { useLocation, useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/kpi-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Plus, Bird, Calendar, Scale, Droplets, Wheat, AlertTriangle, Check, Trash2, Home, Egg, ArrowDownRight, ArrowUpRight, Scissors, Syringe, Upload, Edit, Eye, EyeOff } from "lucide-react";
import { useApp } from "@/lib/store";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
/* The chart strokes below are literals because SVG cannot read a Tailwind
   class. They are niko's palette: amber-500 for feed, brand-500 for water,
   brand-600 for eggs, and gray-400 dashed for the standard. */
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

/**
 * recharts 3 types the Tooltip's `formatter` and `labelFormatter` far more
 * tightly than the version these charts were written against. Widening the
 * component in one place keeps the six call sites exactly as they were.
 */
const Tooltip = RechartsTooltip as unknown as (props: Record<string, unknown>) => ReactElement;
import { getAgeRefStock, isBatchActive } from "@/lib/bird-batches";
import { BhHouseCard, type LiveShed } from "@/components/iot-widgets";
import { api } from "@/api";

/** Whole calendar days between two dates. India keeps no daylight saving, so
 *  UTC arithmetic and local arithmetic agree. */
function differenceInDays(later: Date, earlier: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.trunc((day(later) - day(earlier)) / 86_400_000);
}

/** The `format` patterns these screens use: yyyy-MM-dd and dd MMM yyyy. */
function format(value: Date | string | number, pattern: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (pattern === "yyyy-MM-dd") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (pattern === "dd MMM yyyy") return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}`;
  if (pattern === "dd MMM") return `${pad(d.getDate())} ${months[d.getMonth()]}`;
  if (pattern === "MMM dd") return `${months[d.getMonth()]} ${pad(d.getDate())}`;
  return d.toLocaleDateString("en-GB");
}

interface Shed {
  id: string;
  name: string;
  type: 'pullet' | 'layer';
  displayOrder: number;
  dateOfBirth?: string;
  breedId?: string;
  breed?: string;
}

interface BirdStock {
  id: string;
  /** Not in the original shape — a batch links through to its flock. */
  flockId?: string;
  shedId: string;
  batchNumber: string;
  dateIn: string;
  openingCount: number;
  sourceShedId?: string;
  batchBirthDate?: string;
  isActive?: boolean;
  notes?: string;
}

interface DailyRecord {
  id: string;
  shedId: string;
  date: string;
  mortality: number;
  maleBirds: number;
  birdsTransferredIn: number;
  birdsTransferredOut: number;
  birdsCulled: number;
  waterUpperKl: number;
  waterLowerKl: number;
  feedDeliveredKg: number;
  feedIntakeKg: number;
  feedStockKg: number;
  eggsProduced: number;
  recordedBy: string;
}

interface WeeklyWeight {
  id: string;
  shedId: string;
  weekNumber: number;
  date: string;
  averageWeight: number;
  eggWeight?: number;
  recordedBy: string;
}

interface VaccineStandard {
  id: string;
  age: string;
  vaccineName: string;
  sortOrder: number;
}

interface VaccinationRecord {
  id: string;
  shedId: string;
  date: string;
  vaccineName: string;
  batchNumber?: string;
  make?: string;
  birdsVaccinated?: number;
  vaccinatorCount?: number;
  laboursCount?: number;
  imageUrl?: string;
  recordedBy: string;
}

function calculateAge(dateIn: string, asOf?: Date): { weeks: number; days: number; totalDays: number } {
  const start = new Date(dateIn);
  const ref = asOf || new Date();
  const totalDays = differenceInDays(ref, start);
  return {
    weeks: Math.floor(totalDays / 7),
    days: totalDays % 7,
    totalDays
  };
}

export function HouseDetailPage() {
  const [, setLocation] = useLocation();
  const [match, params] = useRoute("/farms/houses/:id");
  const { state } = useApp();
  const { toast } = useToast();
  const shedId = params?.id;
  const isAdmin = state.currentUser?.isAdmin || false;

  const [shed, setShed] = useState<Shed | null>(null);
  const [stocks, setStocks] = useState<BirdStock[]>([]);
  const [records, setRecords] = useState<DailyRecord[]>([]);
  const [weights, setWeights] = useState<WeeklyWeight[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  /** What the shed's controller says right now, for the house drawing. */
  const [live, setLive] = useState<LiveShed | null>(null);
  
  // Batch history for analytics (fetched but not used for filtering in shed view)
  const [batchHistory, setBatchHistory] = useState<{
    shedId: string;
    batches: Array<{
      batchNumber: string;
      originShedId?: string;
      originDate?: string;
      currentCount: number;
      stocks: BirdStock[];
      dailyRecords: DailyRecord[];
      weeklyWeights: WeeklyWeight[];
      vaccinations: VaccinationRecord[];
      transfers: Array<{
        id: string;
        batchNumber: string;
        fromShedId: string;
        toShedId: string;
        transferDate: string;
        birdCount: number;
      }>;
    }>;
  } | null>(null);
  
  const [showRecordDialog, setShowRecordDialog] = useState(false);
  const [showWeightDialog, setShowWeightDialog] = useState(false);
  
  const [showEditShedDialog, setShowEditShedDialog] = useState(false);
  const [editShedForm, setEditShedForm] = useState({ name: '', type: '' as 'pullet' | 'layer', farmName: '', displayOrder: 0 });
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [editingWeightId, setEditingWeightId] = useState<string | null>(null);
  const [editingVaccinationId, setEditingVaccinationId] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<string>("__all__");
  const [breeds, setBreeds] = useState<{id: string; name: string; description?: string}[]>([]);
  const [breedStandards, setBreedStandards] = useState<{
    weekNumber: number;
    feedGramsPerBird?: number;
    waterMlPerBird?: number;
    eggPercentage?: number;
    mortalityPercent?: number;
    bodyWeightGrams?: number;
  }[]>([]);

  const [stockForm, setStockForm] = useState({
    batchNumber: '',
    dateIn: format(new Date(), 'yyyy-MM-dd'),
    batchBirthDate: '',
    openingCount: '',
    notes: '',
    breedId: '',
    isActive: true,
  });
  
  const [showRecordDetailDialog, setShowRecordDetailDialog] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<DailyRecord | null>(null);
  
  const [transferForm, setTransferForm] = useState({
    batchNumber: '',
    toShedId: '',
    transferDate: format(new Date(), 'yyyy-MM-dd'),
    birdCount: '',
    notes: ''
  });
  const [allSheds, setAllSheds] = useState<Shed[]>([]);

  const [recordForm, setRecordForm] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    mortality: '',
    maleBirds: '',
    birdsTransferredIn: '',
    birdsTransferredOut: '',
    birdsCulled: '',
    waterUpperKl: '',
    waterLowerKl: '',
    feedDeliveredKg: '',
    feedIntakeKg: '',
    feedStockKg: '',
    eggsProduced: ''
  });

  const [weightForm, setWeightForm] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    averageWeight: '',
    eggWeight: ''
  });

  const [vaccinationRecords, setVaccinationRecords] = useState<VaccinationRecord[]>([]);
  const [vaccineStandards, setVaccineStandards] = useState<VaccineStandard[]>([]);
  const [showVaccinationDialog, setShowVaccinationDialog] = useState(false);
  const [vaccinationForm, setVaccinationForm] = useState({
    date: format(new Date(), 'yyyy-MM-dd'),
    vaccineName: '',
    batchNumber: '',
    make: '',
    birdsVaccinated: '',
    vaccinatorCount: '',
    laboursCount: '',
    imageUrl: ''
  });

  const [showBulkUploadDialog, setShowBulkUploadDialog] = useState(false);
  const [bulkUploadData, setBulkUploadData] = useState<any[]>([]);
  const [bulkUploadError, setBulkUploadError] = useState('');
  const [recordLookupDate, setRecordLookupDate] = useState('');
  const [isBulkUploading, setIsBulkUploading] = useState(false);

  const handleBulkCsvParse = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBulkUploadError('');
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      const lines = text.trim().split('\n');
      if (lines.length < 2) {
        setBulkUploadError('CSV must have a header row and at least one data row.');
        return;
      }
      const headers = lines[0]!.split(',').map(h => h.trim().toLowerCase());
      const requiredCols = ['date'];
      const missing = requiredCols.filter(c => !headers.includes(c));
      if (missing.length > 0) {
        setBulkUploadError(`Missing required columns: ${missing.join(', ')}`);
        return;
      }
      const rows: any[] = [];
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i]!.trim()) continue;
        const values = lines[i]!.split(',').map(v => v.trim());
        const row: any = {};
        headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
        if (!row.date) continue;
        const parsed = new Date(row.date);
        if (isNaN(parsed.getTime())) {
          setBulkUploadError(`Invalid date "${row.date}" on row ${i + 1}. Use YYYY-MM-DD format.`);
          setBulkUploadData([]);
          return;
        }
        rows.push({
          date: row.date,
          batchNumber: row.batchnumber || row.batch_number || row.batch || '',
          mortality: row.mortality || '0',
          maleBirds: row.malebirds || row.male_birds || '0',
          birdsTransferredIn: row.birdstransferredin || row.birds_transferred_in || row.transferredin || '0',
          birdsTransferredOut: row.birdstransferredout || row.birds_transferred_out || row.transferredout || '0',
          birdsCulled: row.birdsculled || row.birds_culled || row.culled || '0',
          waterUpperKl: row.waterupperkl || row.water_upper_kl || row.waterupper || '0',
          waterLowerKl: row.waterlowerkl || row.water_lower_kl || row.waterlower || '0',
          feedDeliveredKg: row.feeddeliveredkg || row.feed_delivered_kg || row.feeddelivered || '0',
          feedIntakeKg: row.feedintakekg || row.feed_intake_kg || row.feedintake || '0',
          feedStockKg: row.feedstockkg || row.feed_stock_kg || row.feedstock || '0',
          eggsProduced: row.eggsproduced || row.eggs_produced || row.eggs || '0',
        });
      }
      if (rows.length === 0) {
        setBulkUploadError('No valid data rows found in CSV.');
        return;
      }
      setBulkUploadData(rows);
    };
    reader.readAsText(file);
  };

  const handleBulkUploadSubmit = async () => {
    if (!shedId || bulkUploadData.length === 0) return;
    setIsBulkUploading(true);
    setBulkUploadError('');
    try {
      const res = await apiRequest('POST', `/api/sheds/${shedId}/bulk-daily-records`, { records: bulkUploadData });
      const data = await res.json();
      setShowBulkUploadDialog(false);
      setBulkUploadData([]);
      toast({ title: 'Upload Successful', description: `${data.inserted} records imported successfully.` });
      fetchData();
    } catch (err: any) {
      const errorMsg = err.message || 'Upload failed';
      setBulkUploadError(errorMsg);
      toast({ title: 'Upload Failed', description: errorMsg, variant: 'destructive' });
    } finally {
      setIsBulkUploading(false);
    }
  };

  const downloadCsvTemplate = () => {
    const isLayer = shed?.type === 'layer';
    const headers = isLayer
      ? 'date,batch_number,mortality,birds_culled,water_upper_kl,water_lower_kl,feed_delivered_kg,feed_intake_kg,feed_stock_kg,eggs_produced'
      : 'date,batch_number,mortality,male_birds,birds_culled,water_upper_kl,water_lower_kl,feed_delivered_kg,feed_intake_kg,feed_stock_kg';
    const sample = isLayer
      ? '2026-01-15,,3,0,1200.5,85.3,500,120.5,380,4500'
      : '2026-01-15,,3,0,0,1200.5,85.3,500,120.5,380';
    const csv = headers + '\n' + sample;
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily_records_template_${isLayer ? 'layer' : 'pullet'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fetchData = async () => {
    if (!shedId) return;
    
    try {
      const [shedRes, stockRes, recordsRes, weightsRes, breedsRes, vaccineStandardsRes, vaccinationRecordsRes, batchHistoryRes] = await Promise.all([
        apiRequest('GET', `/api/sheds`),
        apiRequest('GET', `/api/bird-stock/${shedId}`),
        apiRequest('GET', `/api/daily-records/${shedId}`),
        apiRequest('GET', `/api/weekly-weights/${shedId}`),
        apiRequest('GET', `/api/breeds`),
        apiRequest('GET', `/api/vaccine-standards`),
        apiRequest('GET', `/api/vaccination-records/${shedId}`),
        apiRequest('GET', `/api/shed-batch-history/${shedId}`)
      ]);

      const shedsData: Shed[] = await shedRes.json();
      const shedData = shedsData.find(s => s.id === shedId);
      const stockData = await stockRes.json();
      const recordsData = await recordsRes.json();
      const weightsData = await weightsRes.json();
      const breedsData = await breedsRes.json();
      const vaccineStandardsData = await vaccineStandardsRes.json();
      const vaccinationRecordsData = await vaccinationRecordsRes.json();
      const batchHistoryData = await batchHistoryRes.json();

      setShed(shedData || null);
      setStocks(stockData || []);
      setRecords(recordsData || []);
      setWeights(weightsData || []);
      setAllSheds(shedsData || []);
      setBreeds(breedsData || []);
      setVaccineStandards(vaccineStandardsData || []);
      setVaccinationRecords(vaccinationRecordsData || []);
      setBatchHistory(batchHistoryData || null);
      
      const largestStock = stockData && stockData.length > 0
        ? stockData.reduce((largest: any, s: any) => s.openingCount > largest.openingCount ? s : largest, stockData[0])
        : null;
      const activeBreedId = largestStock?.breedId || shedData?.breedId;
      if (activeBreedId) {
        try {
          const standardsRes = await apiRequest('GET', `/api/breed-standards/${activeBreedId}`);
          const standardsData = await standardsRes.json();
          setBreedStandards(standardsData || []);
        } catch (err) {
          console.error('Failed to fetch breed standards:', err);
        }
      } else {
        setBreedStandards([]);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [shedId]);

  useEffect(() => {
    // The controller's own picture, refreshed on the poller's cadence. A shed
    // with no controller (or a dead API) simply shows no card.
    if (!shedId) return;
    let stop = false;
    // The real HTTP helper, NOT apiRequest — apiRequest in this file is the
    // adapter that translates the ported page's legacy URLs, and it would
    // shred this one trying.
    const load = () =>
      api<LiveShed>(`/api/farms/iot/house/${shedId}/live`)
        .then((d) => {
          if (!stop) setLive(d.fetchedAt ? d : null);
        })
        .catch(() => {
          if (!stop) setLive(null);
        });
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [shedId]);

  const availableBatches = useMemo(() => {
    return Array.from(new Set(stocks.map(s => s.batchNumber)));
  }, [stocks]);

  const batchesWithCounts = useMemo(() => {
    return availableBatches.map(batchNumber => {
      const batchStock = stocks.find(s => s.batchNumber === batchNumber);
      const batchRecords = records.filter(r => (r as any).batchNumber === batchNumber);
      const totalMortality = batchRecords.reduce((sum, r) => sum + (r.mortality || 0), 0);
      const totalTransferredIn = batchRecords.reduce((sum, r) => sum + (r.birdsTransferredIn || 0), 0);
      const totalTransferredOut = batchRecords.reduce((sum, r) => sum + (r.birdsTransferredOut || 0), 0);
      const totalCulled = batchRecords.reduce((sum, r) => sum + (r.birdsCulled || 0), 0);
      const totalMaleBirds = batchRecords.reduce((sum, r) => sum + (r.maleBirds || 0), 0);
      const currentBirds = (batchStock?.openingCount || 0) - totalMortality + totalTransferredIn - totalTransferredOut - totalCulled - totalMaleBirds;
      return { batchNumber, currentBirds, stock: batchStock };
    });
  }, [availableBatches, stocks, records]);

  const getActiveBatchesForDate = (dateStr: string): string[] => {
    const targetDate = dateStr.substring(0, 10);
    return stocks
      .filter(s => new Date(s.dateIn).toISOString().substring(0, 10) <= targetDate)
      .filter(s => {
        const batchRecs = records.filter(r => (r as any).batchNumber === s.batchNumber && r.date.substring(0, 10) <= targetDate);
        const mort = batchRecs.reduce((sum, r) => sum + (r.mortality || 0), 0);
        const tIn = batchRecs.reduce((sum, r) => sum + (r.birdsTransferredIn || 0), 0);
        const tOut = batchRecs.reduce((sum, r) => sum + (r.birdsTransferredOut || 0), 0);
        const culled = batchRecs.reduce((sum, r) => sum + (r.birdsCulled || 0), 0);
        const males = batchRecs.reduce((sum, r) => sum + (r.maleBirds || 0), 0);
        return (s.openingCount - mort + tIn - tOut - culled - males) > 0;
      })
      .map(s => s.batchNumber);
  };

  useEffect(() => {
    if (batchesWithCounts.length === 0 && selectedBatch !== "__all__") {
      setSelectedBatch("__all__");
    }
  }, [batchesWithCounts, selectedBatch]);

  const activeBatchNumbers = useMemo(() => {
    return new Set(
      batchesWithCounts
        .filter(b => b.currentBirds > 0 && (b.stock ? isBatchActive(b.stock) : true))
        .map(b => b.batchNumber)
    );
  }, [batchesWithCounts]);

  const filteredStocks = useMemo(() => {
    if (selectedBatch === "__all__") return stocks.filter(s => activeBatchNumbers.has(s.batchNumber));
    return stocks.filter(s => s.batchNumber === selectedBatch);
  }, [stocks, selectedBatch, activeBatchNumbers]);

  const filteredRecords = useMemo(() => {
    if (selectedBatch === "__all__") return records.filter(r => {
      const recBatch = (r as any).batchNumber;
      if (!recBatch) return true;
      return activeBatchNumbers.has(recBatch);
    });
    return records.filter(r => {
      const recBatch = (r as any).batchNumber;
      if (!recBatch) return true;
      return recBatch === selectedBatch;
    });
  }, [records, selectedBatch, activeBatchNumbers]);

  const filteredWeights = useMemo(() => {
    if (selectedBatch === "__all__") return weights.filter((w: any) => {
      if (!w.batchNumber) return true;
      return activeBatchNumbers.has(w.batchNumber);
    });
    return weights.filter((w: any) => {
      if (!w.batchNumber) return true;
      return w.batchNumber === selectedBatch;
    });
  }, [weights, selectedBatch, activeBatchNumbers]);

  const totalOpeningStock = useMemo(() => {
    return filteredStocks.reduce((sum, s) => sum + s.openingCount, 0);
  }, [filteredStocks]);

  const closingStock = useMemo(() => {
    const totalMortality = filteredRecords.reduce((sum, r) => sum + (r.mortality || 0), 0);
    const totalTransferredIn = filteredRecords.reduce((sum, r) => sum + (r.birdsTransferredIn || 0), 0);
    const totalTransferredOut = filteredRecords.reduce((sum, r) => sum + (r.birdsTransferredOut || 0), 0);
    const totalCulled = filteredRecords.reduce((sum, r) => sum + (r.birdsCulled || 0), 0);
    const totalMaleBirds = filteredRecords.reduce((sum, r) => sum + (r.maleBirds || 0), 0);
    return totalOpeningStock - totalMortality + totalTransferredIn - totalTransferredOut - totalCulled - totalMaleBirds;
  }, [totalOpeningStock, filteredRecords]);

  const earliestStock = useMemo(() => {
    const targetStocks = filteredStocks.length > 0 ? filteredStocks : stocks;
    if (targetStocks.length === 0) return null;
    return targetStocks.reduce((earliest, stock) => 
      new Date(stock.dateIn) < new Date(earliest.dateIn) ? stock : earliest
    , targetStocks[0]!);
  }, [filteredStocks, stocks]);

  // The batch that represents the shed's current flock: the active batch with
  // the most live birds (not simply the biggest batch ever placed). Drives age,
  // breed/DOB display, and the age axis on charts.
  const largestBatchStock = useMemo(() => {
    const targetStocks = filteredStocks.length > 0 ? filteredStocks : stocks;
    return getAgeRefStock(targetStocks, filteredRecords as any);
  }, [filteredStocks, stocks, filteredRecords]);
  
  const age = useMemo(() => {
    if (largestBatchStock?.batchBirthDate) {
      return calculateAge(largestBatchStock.batchBirthDate);
    }
    if (largestBatchStock) {
      return calculateAge(largestBatchStock.dateIn);
    }
    if (earliestStock) {
      return calculateAge(earliestStock.dateIn);
    }
    return null;
  }, [earliestStock, largestBatchStock]);

  const shedData = useMemo(() => {
    return { records: filteredRecords, weights: filteredWeights, vaccinations: vaccinationRecords };
  }, [filteredRecords, filteredWeights, vaccinationRecords]);

  const chartData = useMemo(() => {
    // Use all shed records for charts
    const dataRecords = shedData.records as DailyRecord[];
    const sortedRecords = [...dataRecords]
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    // Calculate age reference date - use largest batch's birth date or fall back to other references
    const ageRefDate = largestBatchStock?.batchBirthDate 
      ? new Date(largestBatchStock.batchBirthDate)
      : largestBatchStock 
        ? new Date(largestBatchStock.dateIn) 
        : earliestStock 
          ? new Date(earliestStock.dateIn) 
          : null;
    
    // Create a map of week number to standards for quick lookup
    const standardsMap = new Map<number, typeof breedStandards[0]>();
    breedStandards.forEach(std => {
      standardsMap.set(std.weekNumber, std);
    });
    
    return sortedRecords
      .slice(-14)
      .map(r => {
        const recordDate = new Date(r.date);
        
        // Calculate opening birds for this date (stock batches that existed by this date)
        const openingBirdsFromStock = filteredStocks
          .filter(s => new Date(s.dateIn) <= recordDate)
          .reduce((sum, s) => sum + s.openingCount, 0);
        
        // Get cumulative changes up to previous day to get opening count
        const prevRecords = sortedRecords.filter(rec => new Date(rec.date) < recordDate);
        const prevCumulativeChange = prevRecords.reduce((sum, rec) => {
          return sum + (rec.birdsTransferredIn || 0) - (rec.mortality || 0) - (rec.birdsTransferredOut || 0) - (rec.birdsCulled || 0) - (rec.maleBirds || 0);
        }, 0);
        
        const openingBirds = openingBirdsFromStock + prevCumulativeChange;
        const dayChange = (r.birdsTransferredIn || 0) - (r.mortality || 0) - (r.birdsTransferredOut || 0) - (r.birdsCulled || 0) - (r.maleBirds || 0);
        const closingBirds = openingBirds + dayChange;
        
        const feedIntake = r.feedIntakeKg || 0;
        const waterTotal = (r.waterUpperKl || 0) + (r.waterLowerKl || 0);
        const birdCount = closingBirds > 0 ? closingBirds : 1;
        const eggsProduced = r.eggsProduced || 0;
        
        // Calculate age in weeks for this record date
        let ageWeeks = 0;
        if (ageRefDate) {
          const daysDiff = differenceInDays(recordDate, ageRefDate);
          ageWeeks = Math.floor(daysDiff / 7);
        }
        
        // Get breed standards for this week
        const weekStandard = standardsMap.get(ageWeeks);
        
        return {
          date: format(recordDate, 'dd/MM'),
          ageWeeks: ageWeeks,
          feedPerBird: Math.round((feedIntake * 1000 / birdCount) * 10) / 10,
          waterPerBird: Math.round((waterTotal * 1000000 / birdCount) * 10) / 10,
          mortality: r.mortality || 0,
          eggPercent: Math.round((eggsProduced / birdCount) * 1000) / 10,
          stdFeed: weekStandard?.feedGramsPerBird ?? null,
          stdWater: weekStandard?.waterMlPerBird ?? null,
          stdEggPercent: weekStandard?.eggPercentage ?? null
        };
      });
  }, [shedData, filteredStocks, shed, earliestStock, breedStandards, selectedBatch]);



  const handleDeleteRecord = async (recordId: string) => {
    if (!confirm('Are you sure you want to delete this daily record?')) return;
    try {
      await apiRequest('DELETE', `/api/daily-records/${recordId}`);
      fetchData();
    } catch (error) {
      console.error('Failed to delete record:', error);
    }
  };

  const handleEditRecord = async (record: DailyRecord) => {
    setRecordForm({
      date: format(new Date(record.date), 'yyyy-MM-dd'),
      mortality: record.mortality?.toString() || '',
      maleBirds: record.maleBirds?.toString() || '',
      birdsTransferredIn: record.birdsTransferredIn?.toString() || '',
      birdsTransferredOut: record.birdsTransferredOut?.toString() || '',
      birdsCulled: record.birdsCulled?.toString() || '',
      waterUpperKl: record.waterUpperKl?.toString() || '',
      waterLowerKl: record.waterLowerKl?.toString() || '',
      feedDeliveredKg: record.feedDeliveredKg?.toString() || '',
      feedIntakeKg: record.feedIntakeKg?.toString() || '',
      feedStockKg: record.feedStockKg?.toString() || '',
      eggsProduced: record.eggsProduced?.toString() || ''
    });
    setEditingRecordId(record.id);
    setShowRecordDialog(true);
  };

  const handleDeleteWeight = async (weightId: string) => {
    if (!confirm('Are you sure you want to delete this weight record?')) return;
    try {
      await apiRequest('DELETE', `/api/weekly-weights/${weightId}`);
      fetchData();
    } catch (error) {
      console.error('Failed to delete weight:', error);
    }
  };

  const handleEditWeight = async (weight: WeeklyWeight) => {
    setWeightForm({
      date: format(new Date(weight.date), 'yyyy-MM-dd'),
      averageWeight: weight.averageWeight?.toString() || '',
      eggWeight: weight.eggWeight?.toString() || ''
    });
    setEditingWeightId(weight.id);
    setShowWeightDialog(true);
  };

  const handleDeleteVaccination = async (recordId: string) => {
    if (!confirm('Are you sure you want to delete this vaccination record?')) return;
    try {
      await apiRequest('DELETE', `/api/vaccination-records/${recordId}`);
      fetchData();
    } catch (error) {
      console.error('Failed to delete vaccination record:', error);
    }
  };

  const handleEditVaccination = async (record: VaccinationRecord) => {
    setVaccinationForm({
      date: format(new Date(record.date), 'yyyy-MM-dd'),
      vaccineName: record.vaccineName || '',
      batchNumber: record.batchNumber || '',
      make: record.make || '',
      birdsVaccinated: record.birdsVaccinated?.toString() || '',
      vaccinatorCount: record.vaccinatorCount?.toString() || '',
      laboursCount: record.laboursCount?.toString() || '',
      imageUrl: record.imageUrl || ''
    });
    setEditingVaccinationId(record.id);
    setShowVaccinationDialog(true);
  };


  const handleSaveRecord = async () => {
    if (!shedId) return;

    setIsSaving(true);
    try {
      const activeBatchesOnDate = getActiveBatchesForDate(recordForm.date);
      const activeBatch = shed?.type === 'pullet' && activeBatchesOnDate.length > 0
        ? activeBatchesOnDate[0]
        : null;
      
      await apiRequest(editingRecordId ? 'PATCH' : 'POST', editingRecordId ? `/api/daily-records/${editingRecordId}` : '/api/daily-records', {
        shedId,
        batchNumber: activeBatch,
        date: new Date(recordForm.date).toISOString(),
        mortality: parseInt(recordForm.mortality) || 0,
        maleBirds: parseInt(recordForm.maleBirds) || 0,
        birdsTransferredIn: parseInt(recordForm.birdsTransferredIn) || 0,
        birdsTransferredOut: parseInt(recordForm.birdsTransferredOut) || 0,
        birdsCulled: parseInt(recordForm.birdsCulled) || 0,
        waterUpperKl: parseFloat(recordForm.waterUpperKl) || 0,
        waterLowerKl: parseFloat(recordForm.waterLowerKl) || 0,
        feedDeliveredKg: parseFloat(recordForm.feedDeliveredKg) || 0,
        feedIntakeKg: parseFloat(recordForm.feedIntakeKg) || 0,
        feedStockKg: parseFloat(recordForm.feedStockKg) || 0,
        eggsProduced: parseInt(recordForm.eggsProduced) || 0,
        recordedBy: state.currentUser?.name || 'Unknown'
      });
      setShowRecordDialog(false);
      setEditingRecordId(null);
      setRecordForm({
        date: format(new Date(), 'yyyy-MM-dd'),
        mortality: '',
        maleBirds: '',
        birdsTransferredIn: '',
        birdsTransferredOut: '',
        birdsCulled: '',
        waterUpperKl: '',
        waterLowerKl: '',
        feedDeliveredKg: '',
        feedIntakeKg: '',
        feedStockKg: '',
        eggsProduced: ''
      });
      fetchData();
    } catch (err: any) {
      if (err.status === 409) {
        try {
          const data = err.data ?? {};
          await fetchData();
          const existingRecord = records.find(r => r.id === data.existingRecordId);
          if (existingRecord && confirm('A record already exists for this date. Would you like to edit it instead?')) {
            handleEditRecord(existingRecord);
          } else {
            alert('A record already exists for this date. Please edit the existing record instead.');
            setShowRecordDialog(false);
          }
        } catch {
          alert('A record already exists for this date. Please edit the existing record instead.');
          setShowRecordDialog(false);
        }
        return;
      }
      console.error('Failed to save record:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveWeight = async () => {
    if (!shedId || !weightForm.averageWeight || !age) return;

    setIsSaving(true);
    try {
      const activeBatchesOnDate = getActiveBatchesForDate(weightForm.date);
      const activeBatch = shed?.type === 'pullet' && activeBatchesOnDate.length > 0
        ? activeBatchesOnDate[0]
        : null;
      
      const recordDate = new Date(weightForm.date);
      const birthDateStr = largestBatchStock?.batchBirthDate || largestBatchStock?.dateIn || earliestStock?.dateIn;
      const ageAtRecordDate = birthDateStr ? calculateAge(birthDateStr, recordDate) : age;

      await apiRequest(editingWeightId ? 'PATCH' : 'POST', editingWeightId ? `/api/weekly-weights/${editingWeightId}` : '/api/weekly-weights', {
        shedId,
        batchNumber: activeBatch,
        weekNumber: ageAtRecordDate ? ageAtRecordDate.weeks : 0,
        date: recordDate.toISOString(),
        averageWeight: parseFloat(weightForm.averageWeight),
        eggWeight: weightForm.eggWeight ? parseFloat(weightForm.eggWeight) : null,
        recordedBy: state.currentUser?.name || 'Unknown'
      });
      setShowWeightDialog(false);
      setEditingWeightId(null);
      setWeightForm({
        date: format(new Date(), 'yyyy-MM-dd'),
        averageWeight: '',
        eggWeight: ''
      });
      fetchData();
    } catch (error) {
      console.error('Failed to save weight:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveVaccination = async () => {
    if (!shedId || !vaccinationForm.vaccineName) return;

    setIsSaving(true);
    try {
      const activeBatchesOnDate = getActiveBatchesForDate(vaccinationForm.date);
      const activeBatch = shed?.type === 'pullet' && activeBatchesOnDate.length > 0
        ? activeBatchesOnDate[0]
        : null;
      
      await apiRequest(editingVaccinationId ? 'PATCH' : 'POST', editingVaccinationId ? `/api/vaccination-records/${editingVaccinationId}` : '/api/vaccination-records', {
        shedId,
        date: new Date(vaccinationForm.date).toISOString(),
        vaccineName: vaccinationForm.vaccineName,
        batchNumber: activeBatch,
        make: vaccinationForm.make || null,
        birdsVaccinated: vaccinationForm.birdsVaccinated ? parseInt(vaccinationForm.birdsVaccinated) : null,
        vaccinatorCount: vaccinationForm.vaccinatorCount ? parseInt(vaccinationForm.vaccinatorCount) : null,
        laboursCount: vaccinationForm.laboursCount ? parseInt(vaccinationForm.laboursCount) : null,
        imageUrl: vaccinationForm.imageUrl || null,
        recordedBy: state.currentUser?.name || 'Unknown'
      });
      setShowVaccinationDialog(false);
      setEditingVaccinationId(null);
      setVaccinationForm({
        date: format(new Date(), 'yyyy-MM-dd'),
        vaccineName: '',
        batchNumber: '',
        make: '',
        birdsVaccinated: '',
        vaccinatorCount: '',
        laboursCount: '',
        imageUrl: ''
      });
      fetchData();
    } catch (error) {
      console.error('Failed to save vaccination:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveShedDetails = async () => {
    if (!shedId || !editShedForm.name) return;
    setIsSaving(true);
    try {
      await apiRequest('PATCH', `/api/sheds/${shedId}`, {
        name: editShedForm.name,
        type: editShedForm.type,
        farmName: editShedForm.farmName || null,
        displayOrder: editShedForm.displayOrder,
      });
      setShowEditShedDialog(false);
      fetchData();
      toast({ title: 'Shed updated successfully' });
    } catch (error) {
      console.error('Failed to update shed:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // Calculate available birds for the selected batch
  const getAvailableBirdsForBatch = (batchNumber: string): number => {
    // Get the stock entry for this batch
    const batchStock = stocks.find(s => s.batchNumber === batchNumber);
    if (!batchStock) return 0;
    
    // Calculate current bird count from opening stock minus deductions
    const batchRecords = records.filter(r => (r as any).batchNumber === batchNumber);
    const totalMortality = batchRecords.reduce((sum, r) => sum + (r.mortality || 0), 0);
    const totalTransferredIn = batchRecords.reduce((sum, r) => sum + (r.birdsTransferredIn || 0), 0);
    const totalTransferredOut = batchRecords.reduce((sum, r) => sum + (r.birdsTransferredOut || 0), 0);
    const totalCulled = batchRecords.reduce((sum, r) => sum + (r.birdsCulled || 0), 0);
    const totalMaleBirds = batchRecords.reduce((sum, r) => sum + (r.maleBirds || 0), 0);
    
    return batchStock.openingCount - totalMortality + totalTransferredIn - totalTransferredOut - totalCulled - totalMaleBirds;
  };


  const formOpeningBirds = useMemo(() => {
    const formDate = new Date(recordForm.date);
    if (isNaN(formDate.getTime())) return closingStock;
    
    const openingFromStock = stocks
      .filter(s => new Date(s.dateIn) <= formDate)
      .reduce((sum, s) => sum + s.openingCount, 0);
    
    const prevRecords = records.filter(r => {
      if (editingRecordId && r.id === editingRecordId) return false;
      return new Date(r.date) < formDate;
    });
    
    const prevCumulativeChange = prevRecords.reduce((sum, r) => {
      return sum + (r.birdsTransferredIn || 0) - (r.mortality || 0) - (r.birdsTransferredOut || 0) - (r.birdsCulled || 0) - (r.maleBirds || 0);
    }, 0);
    
    return openingFromStock + prevCumulativeChange;
  }, [recordForm.date, stocks, records, editingRecordId, closingStock]);

  if (isLoading) {
    return (
      <div className="min-h-full space-y-4 bg-soil-50 p-4" data-testid="page-skeleton">
        <div className="h-8 w-48 bg-yolk-100 rounded animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="border rounded-lg p-4 space-y-2 animate-pulse">
              <div className="h-4 w-20 bg-yolk-100 rounded" />
              <div className="h-6 w-16 bg-yolk-100 rounded" />
            </div>
          ))}
        </div>
        <div className="border rounded-lg p-4 space-y-3 animate-pulse">
          <div className="h-5 w-32 bg-yolk-100 rounded" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 py-2">
              <div className="h-4 w-16 bg-yolk-100 rounded" />
              <div className="h-4 flex-1 bg-yolk-100 rounded" />
              <div className="h-4 w-12 bg-yolk-100 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!shed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-soil-50">
        <div className="text-center">
          <p className="text-gray-500 mb-4">Shed not found</p>
          <Button onClick={() => setLocation("/farms/daily")} className="bg-yolk-500 hover:bg-yolk-600">Go Back</Button>
        </div>
      </div>
    );
  }

  const totalWater = parseFloat(recordForm.waterUpperKl || '0') + parseFloat(recordForm.waterLowerKl || '0');
  
  const formMortality = parseInt(recordForm.mortality || '0');
  const formTransferredIn = parseInt(recordForm.birdsTransferredIn || '0');
  const formTransferredOut = parseInt(recordForm.birdsTransferredOut || '0');
  const formCulled = parseInt(recordForm.birdsCulled || '0');
  const formMaleBirds = parseInt(recordForm.maleBirds || '0');
  const formFeedConsumed = parseFloat(recordForm.feedIntakeKg || '0');
  const formEggsProduced = parseInt(recordForm.eggsProduced || '0');
  
  const formClosingBirds = formOpeningBirds - formMortality + formTransferredIn - formTransferredOut - formCulled - formMaleBirds;
  
  const waterPerBird = formClosingBirds > 0 ? (totalWater * 1000000 / formClosingBirds) : 0;
  const feedPerBird = formClosingBirds > 0 ? (formFeedConsumed * 1000 / formClosingBirds) : 0;
  const eggPercent = formClosingBirds > 0 ? (formEggsProduced / formClosingBirds) * 100 : 0;

  return (
    <div className="min-h-screen bg-soil-50 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="page-header -mx-4 mb-6 flex items-center gap-4 px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLocation("/farms/daily")}
            data-testid="button-back"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-yolk-400 to-yolk-600 text-white shadow-sm">
            <Bird className="h-4 w-4" />
          </span>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-extrabold tracking-tight text-soil-900">{shed.name}</h1>
              <Badge variant={shed.type === 'pullet' ? 'secondary' : 'default'}>
                {shed.type}
              </Badge>
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setEditShedForm({ name: shed.name, type: shed.type, farmName: (shed as any).farmName || '', displayOrder: shed.displayOrder });
                    setShowEditShedDialog(true);
                  }}
                  data-testid="button-edit-shed"
                >
                  <Edit className="w-3 h-3 mr-1" /> Edit Shed
                </Button>
              )}
              {batchesWithCounts.length > 0 && (
                <Select value={selectedBatch} onValueChange={(val) => setSelectedBatch(val)}>
                  <SelectTrigger className="w-auto h-8 text-xs gap-1" data-testid="select-batch">
                    <SelectValue placeholder="All Batches" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__" data-testid="select-batch-all">
                      All Batches ({batchesWithCounts.reduce((s, b) => s + Math.max(0, b.currentBirds), 0).toLocaleString()} birds)
                    </SelectItem>
                    {batchesWithCounts.map(b => (
                      <SelectItem key={b.batchNumber} value={b.batchNumber} data-testid={`select-batch-${b.batchNumber}`}>
                        {b.batchNumber} ({b.currentBirds > 0 ? `${b.currentBirds.toLocaleString()} birds` : 'Empty'})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {age && (
              <p className="text-soil-400 text-sm">
                Age: {age.weeks} weeks, {age.days} days
              </p>
            )}
            {largestBatchStock && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                <p className="text-xs text-soil-400">
                  Breed: {breeds.find(b => b.id === (largestBatchStock as any).breedId)?.name || 'Not set'}
                </p>
                <p className="text-xs text-soil-400">
                  DOB: {largestBatchStock.batchBirthDate ? format(new Date(largestBatchStock.batchBirthDate), 'dd MMM yyyy') : 'Not set'}
                </p>
              </div>
            )}
          </div>
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => setLocation("/feed")}
            data-testid="button-home"
          >
            <Home className="w-4 h-4 mr-2" />
            Home
          </Button>
        </div>

        {/* Live sensor snapshot — links to full sensors page */}
        {/* Live sensor card omitted — no IoT integration in niko yet. */}

        {stocks.length === 0 ? (
          <Card className="mb-6 rounded-2xl border-0 bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
            <CardContent className="py-12 text-center">
              <Bird className="w-12 h-12 mx-auto mb-4 text-gray-300" />
              <h3 className="text-lg font-medium text-gray-600 mb-2">No Birds Placed Yet</h3>
              {/*
                Batches are not created here. A batch keeps one record across
                every shed it lives in, so it is made on the Batches screen and
                placed into a house from there; a house reports what it happens
                to be holding.
              */}
              <p className="text-gray-400 mb-4">
                Batches are created on the Batches screen, then placed into a house.
              </p>
              <Button onClick={() => setLocation("/farms/batches")} className="bg-yolk-500 hover:bg-yolk-600" data-testid="button-go-batches">
                Go to Batches
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <KpiCard
                label="Opening"
                value={totalOpeningStock.toLocaleString()}
                icon={Bird}
                accent="bg-yolk-500"
                className="rounded-2xl shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]"
                data-testid="text-opening-stock"
              />
              <KpiCard
                label="Current"
                value={closingStock.toLocaleString()}
                icon={Check}
                accent="bg-soil-600"
                className="rounded-2xl shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]"
                data-testid="text-closing-stock"
              />
              <KpiCard
                label="Total Mortality"
                value={filteredRecords.reduce((sum, r) => sum + (r.mortality || 0), 0).toLocaleString()}
                icon={AlertTriangle}
                accent="bg-destructive"
                className="rounded-2xl shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]"
                data-testid="text-total-mortality"
              />
              <KpiCard
                label="Age"
                value={age ? `${age.weeks}w ${age.days}d` : '-'}
                icon={Calendar}
                accent="bg-yolk-600"
                className="rounded-2xl shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]"
                data-testid="text-age"
              />
            </div>

            {/* The bhfarm-style house drawing — the controller's own picture of
                the shed, in the layout the staff already read on bhfarm.net.
                Only when the shed has a reporting controller. */}
            {live && (
              <div className="mb-6 max-w-md">
                <BhHouseCard name={shed.name} live={live} />
              </div>
            )}

            {chartData.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <Card className="rounded-2xl border-0 bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Wheat className="w-4 h-4 text-yolk-600" />
                      Feed per Bird (grams) vs Age
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[200px] sm:h-[250px] md:h-[300px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis 
                            dataKey="ageWeeks" 
                            tick={{ fontSize: 10 }} 
                            label={{ value: 'Age (weeks)', position: 'bottom', fontSize: 10, offset: -5 }}
                          />
                          <YAxis tick={{ fontSize: 10 }} />
                          <Tooltip 
                            formatter={(value: number, name: string) => [
                              `${value} g`, 
                              name === 'Standard' ? 'Standard' : 'Actual'
                            ]}
                            labelFormatter={(label: number) => `Week ${label}`}
                          />
                          <Legend />
                          <Line 
                            type="monotone" 
                            dataKey="feedPerBird" 
                            stroke="#f98a12" 
                            strokeWidth={2}
                            dot={{ r: 3 }}
                            name="Actual"
                          />
                          {breedStandards.length > 0 && (
                            <Line 
                              type="monotone" 
                              dataKey="stdFeed" 
                              stroke="#9ca3af" 
                              strokeWidth={2}
                              strokeDasharray="5 5"
                              dot={false}
                              name="Standard"
                              connectNulls
                            />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-2xl border-0 bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Droplets className="w-4 h-4 text-soil-600" />
                      Water per Bird (ml) vs Age
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[200px] sm:h-[250px] md:h-[300px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis 
                            dataKey="ageWeeks" 
                            tick={{ fontSize: 10 }} 
                            label={{ value: 'Age (weeks)', position: 'bottom', fontSize: 10, offset: -5 }}
                          />
                          <YAxis tick={{ fontSize: 10 }} />
                          <Tooltip 
                            formatter={(value: number, name: string) => [
                              `${value} ml`, 
                              name === 'Standard' ? 'Standard' : 'Actual'
                            ]}
                            labelFormatter={(label: number) => `Week ${label}`}
                          />
                          <Legend />
                          <Line 
                            type="monotone" 
                            dataKey="waterPerBird" 
                            stroke="#6b5a3f" 
                            strokeWidth={2}
                            dot={{ r: 3 }}
                            name="Actual"
                          />
                          {breedStandards.length > 0 && (
                            <Line 
                              type="monotone" 
                              dataKey="stdWater" 
                              stroke="#9ca3af" 
                              strokeWidth={2}
                              strokeDasharray="5 5"
                              dot={false}
                              name="Standard"
                              connectNulls
                            />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                {shed?.type === 'layer' && (
                  <Card className="md:col-span-2 rounded-2xl border-0 bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Egg className="w-4 h-4 text-yolk-700" />
                        Egg Production (%) vs Age (weeks)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="h-[200px] sm:h-[250px] md:h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis 
                              dataKey="ageWeeks" 
                              tick={{ fontSize: 10 }} 
                              label={{ value: 'Age (weeks)', position: 'bottom', fontSize: 10, offset: -5 }}
                            />
                            <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} />
                            <Tooltip 
                              formatter={(value: number, name: string) => [
                                `${value}%`, 
                                name === 'Standard' ? 'Standard' : 'Actual'
                              ]}
                              labelFormatter={(label: number) => `Week ${label}`}
                            />
                            <Legend />
                            <Line 
                              type="monotone" 
                              dataKey="eggPercent" 
                              stroke="#e06d05" 
                              strokeWidth={2}
                              dot={{ r: 3 }}
                              name="Actual"
                            />
                            {breedStandards.length > 0 && (
                              <Line 
                                type="monotone" 
                                dataKey="stdEggPercent" 
                                stroke="#9ca3af" 
                                strokeWidth={2}
                                strokeDasharray="5 5"
                                dot={false}
                                name="Standard"
                                connectNulls
                              />
                            )}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            <Tabs defaultValue="daily" className="space-y-4">
              <TabsList>
                <TabsTrigger value="daily">Daily Records</TabsTrigger>
                <TabsTrigger value="weights">Weekly Weights</TabsTrigger>
                <TabsTrigger value="vaccination">Vaccination</TabsTrigger>
                <TabsTrigger value="batches">Bird Batches ({stocks.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="daily">
                <Card className="rounded-2xl border-0 bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Daily Records</CardTitle>
                    <div className="flex gap-2">
                      {isAdmin && (
                        <Dialog open={showBulkUploadDialog} onOpenChange={(open) => { setShowBulkUploadDialog(open); if (!open) { setBulkUploadData([]); setBulkUploadError(''); } }}>
                          <DialogTrigger asChild>
                            <Button size="sm" variant="outline" className="min-h-[44px]" data-testid="button-bulk-upload">
                              <Upload className="w-4 h-4 mr-2" />
                              Bulk Upload
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                            <DialogHeader>
                              <DialogTitle>Bulk Upload Daily Records</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-4 pt-2">
                              <p className="text-sm text-muted-foreground">
                                Upload a CSV file with daily records. Each row must have a unique date. If any date already has a record, the entire upload will be rejected.
                                {stocks.length > 0 && (
                                  <span> Batch number is optional — if left empty, records will be assigned to <strong>{stocks[0]?.batchNumber}</strong>.</span>
                                )}
                              </p>
                              <Button variant="link" className="p-0 h-auto text-sm" onClick={downloadCsvTemplate} data-testid="button-download-template">
                                Download CSV Template
                              </Button>
                              <div>
                                <Label>Select CSV File</Label>
                                <Input
                                  type="file"
                                  accept=".csv"
                                  onChange={handleBulkCsvParse}
                                  className="min-h-[44px]"
                                  data-testid="input-bulk-csv"
                                />
                              </div>
                              {bulkUploadError && (
                                <div className="bg-destructive/10 border border-destructive/40 rounded p-3 text-sm text-destructive" data-testid="text-bulk-error">
                                  {bulkUploadError}
                                </div>
                              )}
                              {bulkUploadData.length > 0 && (
                                <div>
                                  <p className="text-sm font-medium mb-2">{bulkUploadData.length} records found in CSV:</p>
                                  <div className="max-h-64 overflow-auto border rounded">
                                    <table className="w-full text-xs">
                                      <thead className="sticky top-0">
                                        <tr className="border-b border-soil-100">
                                          <th className="whitespace-nowrap bg-soil-50 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-soil-400">Date</th>
                                          <th className="whitespace-nowrap bg-soil-50 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-soil-400">Batch</th>
                                          <th className="whitespace-nowrap bg-soil-50 px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-soil-400">Mortality</th>
                                          {shed?.type !== 'layer' && <th className="whitespace-nowrap bg-soil-50 px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-soil-400">Male Birds</th>}
                                          <th className="whitespace-nowrap bg-soil-50 px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-soil-400">Feed Intake</th>
                                          <th className="whitespace-nowrap bg-soil-50 px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-soil-400">Water Upper</th>
                                          {shed?.type === 'layer' && <th className="whitespace-nowrap bg-soil-50 px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-soil-400">Eggs</th>}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {bulkUploadData.map((row, i) => (
                                          <tr key={i} className="border-b border-soil-100/70">
                                            <td className="p-2">{row.date}</td>
                                            <td className="p-2 text-muted-foreground text-xs">{row.batchNumber || '(auto)'}</td>
                                            <td className="p-2 text-right tabular-nums">{row.mortality}</td>
                                            {shed?.type !== 'layer' && <td className="p-2 text-right tabular-nums">{row.maleBirds}</td>}
                                            <td className="p-2 text-right tabular-nums">{row.feedIntakeKg}</td>
                                            <td className="p-2 text-right tabular-nums">{row.waterUpperKl}</td>
                                            {shed?.type === 'layer' && <td className="p-2 text-right tabular-nums">{row.eggsProduced}</td>}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                  <div className="flex justify-end gap-2 mt-4">
                                    <Button variant="outline" onClick={() => { setBulkUploadData([]); setBulkUploadError(''); }} data-testid="button-bulk-cancel">
                                      Cancel
                                    </Button>
                                    <Button onClick={handleBulkUploadSubmit} disabled={isBulkUploading} className="bg-yolk-500 hover:bg-yolk-600" data-testid="button-bulk-submit">
                                      {isBulkUploading ? 'Uploading...' : `Upload ${bulkUploadData.length} Records`}
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </DialogContent>
                        </Dialog>
                      )}
                    <Dialog open={showRecordDialog} onOpenChange={(open) => { setShowRecordDialog(open); if (!open) setEditingRecordId(null); }}>
                      <DialogTrigger asChild>
                        <Button size="sm" className="min-h-[44px] bg-yolk-500 hover:bg-yolk-600" data-testid="button-add-record">
                          <Plus className="w-4 h-4 mr-2" />
                          Add Record
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                          <DialogTitle>{editingRecordId ? 'Edit Daily Record' : 'Add Daily Record'}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-6 pt-4">
                          <div>
                            <Label>Date</Label>
                            <Input
                              type="date"
                              value={recordForm.date}
                              onChange={(e) => setRecordForm(prev => ({ ...prev, date: e.target.value }))}
                              className="min-h-[44px]"
                              data-testid="input-record-date"
                              max={isAdmin ? undefined : format(new Date(), 'yyyy-MM-dd')}
                              min={isAdmin ? undefined : format(new Date(), 'yyyy-MM-dd')}
                              disabled={!isAdmin}
                            />
                            {!isAdmin && (
                              <p className="text-xs text-gray-500 mt-1">Only admins can add records for past dates</p>
                            )}
                            {!editingRecordId && recordForm.date && records.some(r => format(new Date(r.date), 'yyyy-MM-dd') === recordForm.date) && (
                              <p className="text-xs text-destructive mt-1 font-medium">A record already exists for this date. Please edit the existing record instead.</p>
                            )}
                          </div>

                          <div className="rounded-2xl bg-white p-4 space-y-3 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                            <h4 className="font-semibold flex items-center gap-2 text-soil-700">
                              <Bird className="w-4 h-4" />
                              Birds
                            </h4>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <Label className="text-xs flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3 text-destructive" />
                                  Mortality
                                </Label>
                                <Input
                                  type="number"
                                  placeholder="0"
                                  value={recordForm.mortality}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, mortality: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-mortality"
                                />
                              </div>
                              <div>
                                <Label className="text-xs flex items-center gap-1">
                                  <ArrowDownRight className="w-3 h-3 text-success" />
                                  Transferred In
                                </Label>
                                <Input
                                  type="number"
                                  placeholder="0"
                                  value={recordForm.birdsTransferredIn}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, birdsTransferredIn: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-birds-transferred-in"
                                />
                              </div>
                              <div>
                                <Label className="text-xs flex items-center gap-1">
                                  <ArrowUpRight className="w-3 h-3 text-warning" />
                                  Transferred Out
                                </Label>
                                <Input
                                  type="number"
                                  placeholder="0"
                                  value={recordForm.birdsTransferredOut}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, birdsTransferredOut: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-birds-transferred-out"
                                />
                              </div>
                              <div>
                                <Label className="text-xs flex items-center gap-1">
                                  <Scissors className="w-3 h-3 text-gray-500" />
                                  Culled
                                </Label>
                                <Input
                                  type="number"
                                  placeholder="0"
                                  value={recordForm.birdsCulled}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, birdsCulled: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-birds-culled"
                                />
                              </div>
                            </div>
                            <div className="text-sm bg-soil-50 p-2 rounded flex justify-between">
                              <span>Opening: <strong>{formOpeningBirds.toLocaleString()}</strong></span>
                              <span>Closing: <strong className={formClosingBirds < 0 ? 'text-destructive' : 'text-success'}>{formClosingBirds.toLocaleString()}</strong></span>
                            </div>
                          </div>

                          <div className="rounded-2xl bg-white p-4 space-y-3 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                            <h4 className="font-semibold flex items-center gap-2 text-soil-800">
                              <Droplets className="w-4 h-4" />
                              Water
                            </h4>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <Label className="text-xs">Upper Level (kL)</Label>
                                <Input
                                  type="number"
                                  step="0.01"
                                  placeholder="0.00"
                                  value={recordForm.waterUpperKl}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, waterUpperKl: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-water-upper"
                                />
                              </div>
                              <div>
                                <Label className="text-xs">Lower Level (kL)</Label>
                                <Input
                                  type="number"
                                  step="0.01"
                                  placeholder="0.00"
                                  value={recordForm.waterLowerKl}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, waterLowerKl: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-water-lower"
                                />
                              </div>
                            </div>
                            <div className="text-sm bg-soil-100 p-2 rounded-lg flex justify-between">
                              <span>Total: <strong>{totalWater.toFixed(2)} kL</strong></span>
                              <span>Per Bird: <strong>{waterPerBird.toFixed(1)} ml</strong></span>
                            </div>
                          </div>

                          <div className="rounded-2xl bg-white p-4 space-y-3 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                            <h4 className="font-semibold flex items-center gap-2 text-yolk-600">
                              <Wheat className="w-4 h-4" />
                              Feed
                            </h4>
                            <div className="grid grid-cols-3 gap-3">
                              <div>
                                <Label className="text-xs">Delivered (kg)</Label>
                                <Input
                                  type="number"
                                  step="0.1"
                                  placeholder="0.0"
                                  value={recordForm.feedDeliveredKg}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, feedDeliveredKg: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-feed-delivered"
                                />
                              </div>
                              <div>
                                <Label className="text-xs">Consumed (kg)</Label>
                                <Input
                                  type="number"
                                  step="0.1"
                                  placeholder="0.0"
                                  value={recordForm.feedIntakeKg}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, feedIntakeKg: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-feed-consumed"
                                />
                              </div>
                              <div>
                                <Label className="text-xs">Stock (kg)</Label>
                                <Input
                                  type="number"
                                  step="0.1"
                                  placeholder="0.0"
                                  value={recordForm.feedStockKg}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, feedStockKg: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-feed-stock"
                                />
                              </div>
                            </div>
                            <div className="text-sm bg-yolk-50 p-2 rounded-lg">
                              Per Bird: <strong>{feedPerBird.toFixed(1)} grams</strong>
                            </div>
                          </div>

                          {shed.type === 'layer' && (
                            <div className="rounded-2xl bg-white p-4 space-y-3 shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                              <h4 className="font-semibold flex items-center gap-2 text-yolk-700">
                                <Egg className="w-4 h-4" />
                                Eggs (Layer House)
                              </h4>
                              <div>
                                <Label className="text-xs">Eggs Produced</Label>
                                <Input
                                  type="number"
                                  placeholder="0"
                                  value={recordForm.eggsProduced}
                                  onChange={(e) => setRecordForm(prev => ({ ...prev, eggsProduced: e.target.value }))}
                                  className="min-h-[44px]"
                                  data-testid="input-eggs-produced"
                                />
                              </div>
                              <div className="text-sm bg-yolk-100 p-2 rounded-lg">
                                Egg %: <strong>{eggPercent.toFixed(1)}%</strong> (per 100 birds)
                              </div>
                            </div>
                          )}

                          <Button 
                            className="w-full min-h-[44px] bg-yolk-500 hover:bg-yolk-600" 
                            onClick={handleSaveRecord}
                            disabled={Boolean(isSaving || formClosingBirds < 0 || (!editingRecordId && recordForm.date && records.some(r => format(new Date(r.date), 'yyyy-MM-dd') === recordForm.date)))}
                            data-testid="button-save-record"
                          >
                            {isSaving ? 'Saving...' : formClosingBirds < 0 ? 'Invalid: Closing birds cannot be negative' : (!editingRecordId && recordForm.date && records.some(r => format(new Date(r.date), 'yyyy-MM-dd') === recordForm.date)) ? 'Record exists for this date' : (editingRecordId ? 'Update Record' : 'Save Record')}
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {shedData.records.length === 0 ? (
                      <div className="text-center py-8 text-gray-400">
                        No daily records yet
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 mb-3">
                          <Label className="text-xs whitespace-nowrap">Jump to date:</Label>
                          <Input
                            type="date"
                            value={recordLookupDate}
                            onChange={(e) => setRecordLookupDate(e.target.value)}
                            className="w-auto min-h-[36px] text-sm"
                            data-testid="input-record-lookup-date"
                          />
                          {recordLookupDate && (
                            <Button variant="ghost" size="sm" className="text-xs h-7 px-2" onClick={() => setRecordLookupDate('')} data-testid="button-clear-lookup-date">
                              Clear
                            </Button>
                          )}
                          <span className="text-xs text-muted-foreground ml-auto">
                            {shedData.records.length} total records
                          </span>
                        </div>
                        {(() => {
                          const allRecords = shedData.records as DailyRecord[];
                          let displaySlice: DailyRecord[];
                          if (recordLookupDate) {
                            const targetDate = recordLookupDate;
                            const targetIdx = allRecords.findIndex(r => format(new Date(r.date), 'yyyy-MM-dd') === targetDate);
                            if (targetIdx >= 0) {
                              const startIdx = Math.max(0, targetIdx - 2);
                              const endIdx = Math.min(allRecords.length, targetIdx + 3);
                              displaySlice = allRecords.slice(startIdx, endIdx);
                            } else {
                              const sorted = allRecords.map((r, i) => ({
                                idx: i,
                                diff: Math.abs(new Date(r.date).getTime() - new Date(targetDate).getTime())
                              })).sort((a, b) => a.diff - b.diff);
                              const closestIdx = sorted[0]?.idx ?? 0;
                              const startIdx = Math.max(0, closestIdx - 2);
                              const endIdx = Math.min(allRecords.length, closestIdx + 3);
                              displaySlice = allRecords.slice(startIdx, endIdx);
                            }
                          } else {
                            displaySlice = allRecords.slice(0, 5);
                          }
                          return displaySlice.map((record) => {
                          // Simple calculations - no pro-rata
                          const recordWaterMl = ((record.waterUpperKl || 0) + (record.waterLowerKl || 0)) * 1000000;
                          const recordDate = new Date(record.date);
                          const displayRecords = shedData.records as DailyRecord[];
                          
                          // Calculate bird count for this record's date
                          const openingBirdsForRecord = stocks
                            .filter(s => new Date(s.dateIn) <= recordDate)
                            .reduce((sum, s) => sum + s.openingCount, 0);
                          const prevRecords = displayRecords.filter(r => new Date(r.date) < recordDate);
                          const prevChanges = prevRecords.reduce((sum, r) => {
                            return sum + (r.birdsTransferredIn || 0) - (r.mortality || 0) - (r.birdsTransferredOut || 0) - (r.birdsCulled || 0) - (r.maleBirds || 0);
                          }, 0);
                          const dayChange = (record.birdsTransferredIn || 0) - (record.mortality || 0) - (record.birdsTransferredOut || 0) - (record.birdsCulled || 0) - (record.maleBirds || 0);
                          const closingBirdsForRecord = openingBirdsForRecord + prevChanges + dayChange;
                          const birdCount = closingBirdsForRecord > 0 ? closingBirdsForRecord : 1;
                          
                          const waterMlPerBird = Math.round(recordWaterMl / birdCount);
                          const feedGramsPerBird = Math.round((record.feedIntakeKg || 0) * 1000 / birdCount);
                          const eggPercent = closingBirdsForRecord > 0 
                            ? Math.round(((record.eggsProduced || 0) / closingBirdsForRecord) * 1000) / 10 
                            : 0;
                          
                          const ageRefDate = shed?.type === 'layer' && shed.dateOfBirth 
                            ? new Date(shed.dateOfBirth)
                            : earliestStock ? new Date(earliestStock.dateIn) : null;
                          const recordAgeWeeks = ageRefDate 
                            ? Math.floor(differenceInDays(recordDate, ageRefDate) / 7)
                            : 0;
                          const weekStd = breedStandards.find(s => s.weekNumber === recordAgeWeeks);
                          
                          return (
                            <div 
                              key={record.id} 
                              className="flex items-center justify-between p-3 bg-soil-50 rounded-lg cursor-pointer hover:bg-yolk-50/70 transition-colors"
                              data-testid={`record-${record.id}`}
                              onClick={() => {
                                setSelectedRecord(record);
                                setShowRecordDetailDialog(true);
                              }}
                            >
                              <div>
                                <div className="font-medium">
                                  {format(new Date(record.date), 'dd MMM yyyy')}
                                </div>
                                <div className="text-sm text-gray-500">
                                  by {record.recordedBy} {ageRefDate && <span className="text-xs">(Week {recordAgeWeeks})</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-4 text-sm flex-wrap justify-end">
                                <div className="text-destructive">
                                  <AlertTriangle className="w-3 h-3 inline mr-1" />
                                  {record.mortality}
                                </div>
                                <div className="text-info">
                                  <Droplets className="w-3 h-3 inline mr-1" />
                                  {waterMlPerBird.toLocaleString()} ml
                                  {weekStd?.waterMlPerBird && (
                                    <span className={`text-xs ml-1 ${waterMlPerBird >= (weekStd.waterMlPerBird * 0.9) && waterMlPerBird <= (weekStd.waterMlPerBird * 1.1) ? 'text-success' : 'text-destructive'}`}>
                                      ({weekStd.waterMlPerBird})
                                    </span>
                                  )}
                                </div>
                                <div className="text-warning">
                                  <Wheat className="w-3 h-3 inline mr-1" />
                                  {feedGramsPerBird} g
                                  {weekStd?.feedGramsPerBird && (
                                    <span className={`text-xs ml-1 ${feedGramsPerBird >= (weekStd.feedGramsPerBird * 0.9) && feedGramsPerBird <= (weekStd.feedGramsPerBird * 1.1) ? 'text-success' : 'text-destructive'}`}>
                                      ({weekStd.feedGramsPerBird})
                                    </span>
                                  )}
                                </div>
                                {shed?.type === 'layer' && (
                                  <div className="text-warning">
                                    <Egg className="w-3 h-3 inline mr-1" />
                                    {eggPercent}%
                                    {weekStd?.eggPercentage && (
                                      <span className={`text-xs ml-1 ${eggPercent >= (weekStd.eggPercentage * 0.95) ? 'text-success' : 'text-destructive'}`}>
                                        ({weekStd.eggPercentage})
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                              {isAdmin && (
                                <div className="flex items-center gap-1 ml-2">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-info hover:text-info/80"
                                    onClick={(e) => { e.stopPropagation(); handleEditRecord(record); }}
                                    data-testid={`button-edit-record-${record.id}`}
                                  >
                                    <Edit className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive/80"
                                    onClick={(e) => { e.stopPropagation(); handleDeleteRecord(record.id); }}
                                    data-testid={`button-delete-record-${record.id}`}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })
                        })()}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="weights">
                <Card className="rounded-2xl border-0 bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Weekly Weights</CardTitle>
                    <Dialog open={showWeightDialog} onOpenChange={(open) => { setShowWeightDialog(open); if (!open) setEditingWeightId(null); }}>
                      <DialogTrigger asChild>
                        <Button size="sm" className="min-h-[44px] bg-yolk-500 hover:bg-yolk-600" data-testid="button-add-weight">
                          <Plus className="w-4 h-4 mr-2" />
                          Add Weight
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>{editingWeightId ? 'Edit Weekly Weight' : 'Record Weekly Weight'}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4 pt-4">
                          <div>
                            <Label>Date</Label>
                            <Input
                              type="date"
                              value={weightForm.date}
                              onChange={(e) => setWeightForm(prev => ({ ...prev, date: e.target.value }))}
                              data-testid="input-weight-date"
                            />
                          </div>
                          {(() => {
                            const birthStr = largestBatchStock?.batchBirthDate || largestBatchStock?.dateIn || earliestStock?.dateIn;
                            const selectedAge = birthStr ? calculateAge(birthStr, new Date(weightForm.date)) : age;
                            return (
                              <div className="text-sm text-gray-500 bg-soil-50 p-2 rounded">
                                Week {selectedAge?.weeks} ({weightForm.date === format(new Date(), 'yyyy-MM-dd') ? 'today' : weightForm.date})
                              </div>
                            );
                          })()}
                          <div>
                            <Label className="flex items-center gap-2">
                              <Scale className="w-4 h-4" />
                              Bird Weight (grams)
                            </Label>
                            <Input
                              type="number"
                              step="0.1"
                              placeholder="e.g., 1500"
                              value={weightForm.averageWeight}
                              onChange={(e) => setWeightForm(prev => ({ ...prev, averageWeight: e.target.value }))}
                              data-testid="input-average-weight"
                            />
                          </div>
                          {shed?.type === 'layer' && (
                            <div>
                              <Label className="flex items-center gap-2">
                                <Egg className="w-4 h-4" />
                                Egg Weight (grams)
                              </Label>
                              <Input
                                type="number"
                                step="0.1"
                                placeholder="e.g., 60"
                                value={weightForm.eggWeight}
                                onChange={(e) => setWeightForm(prev => ({ ...prev, eggWeight: e.target.value }))}
                                data-testid="input-egg-weight"
                              />
                            </div>
                          )}
                          <Button 
                            className="w-full min-h-[44px] bg-yolk-500 hover:bg-yolk-600" 
                            onClick={handleSaveWeight}
                            disabled={isSaving || !weightForm.averageWeight}
                            data-testid="button-save-weight"
                          >
                            {isSaving ? 'Saving...' : 'Save Weight'}
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </CardHeader>
                  <CardContent>
                    {(shedData.weights as WeeklyWeight[]).length === 0 ? (
                      <div className="text-center py-8 text-gray-400">
                        No weight records yet
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {(shedData.weights as WeeklyWeight[]).map((weight) => (
                          <div 
                            key={weight.id} 
                            className="flex items-center justify-between p-3 bg-soil-50 rounded-lg"
                            data-testid={`weight-${weight.id}`}
                          >
                            <div>
                              <div className="font-medium">
                                Week {weight.weekNumber}
                              </div>
                              <div className="text-sm text-gray-500">
                                {format(new Date(weight.date), 'dd MMM yyyy')}
                              </div>
                            </div>
                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-1">
                                <Scale className="w-4 h-4 text-gray-400" />
                                <span className="font-medium">{weight.averageWeight} g</span>
                              </div>
                              {shed?.type === 'layer' && weight.eggWeight && (
                                <div className="flex items-center gap-1">
                                  <Egg className="w-4 h-4 text-warning" />
                                  <span className="font-medium">{weight.eggWeight} g</span>
                                </div>
                              )}
                              {isAdmin && (
                                <div className="flex items-center gap-1 ml-2">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-info hover:text-info/80"
                                    onClick={() => handleEditWeight(weight)}
                                    data-testid={`button-edit-weight-${weight.id}`}
                                  >
                                    <Edit className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive/80"
                                    onClick={() => handleDeleteWeight(weight.id)}
                                    data-testid={`button-delete-weight-${weight.id}`}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="vaccination">
                <Card className="rounded-2xl border-0 bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <Syringe className="w-5 h-5" />
                      Vaccination History
                    </CardTitle>
                    <Dialog open={showVaccinationDialog} onOpenChange={(open) => { setShowVaccinationDialog(open); if (!open) setEditingVaccinationId(null); }}>
                      <DialogTrigger asChild>
                        <Button size="sm" className="min-h-[44px] bg-yolk-500 hover:bg-yolk-600" data-testid="button-add-vaccination">
                          <Plus className="w-4 h-4 mr-2" />
                          Add Record
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                          <DialogTitle>{editingVaccinationId ? 'Edit Vaccination Record' : 'Add Vaccination Record'}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4 pt-4">
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <Label>Date</Label>
                              <Input
                                type="date"
                                value={vaccinationForm.date}
                                onChange={(e) => setVaccinationForm(prev => ({ ...prev, date: e.target.value }))}
                                className="min-h-[44px]"
                                data-testid="input-vaccination-date"
                              />
                            </div>
                            <div>
                              <Label>Flock Age</Label>
                              <div className="min-h-[44px] flex items-center px-3 bg-muted rounded-md text-sm font-medium" data-testid="display-flock-age">
                                {(() => {
                                  const ageRef = shed?.dateOfBirth ? new Date(shed.dateOfBirth) : (earliestStock ? new Date(earliestStock.dateIn) : null);
                                  if (!ageRef || !vaccinationForm.date) return 'Select date';
                                  const selectedDate = new Date(vaccinationForm.date);
                                  const days = differenceInDays(selectedDate, ageRef);
                                  if (days < 0) return 'Before flock start';
                                  if (days < 7) return `Day ${days + 1}`;
                                  return `Week ${Math.floor(days / 7) + 1}`;
                                })()}
                              </div>
                            </div>
                          </div>
                          <div>
                            <Label>Vaccine Name</Label>
                            <Select
                              value={vaccinationForm.vaccineName}
                              onValueChange={(value) => setVaccinationForm(prev => ({ ...prev, vaccineName: value }))}
                            >
                              <SelectTrigger className="min-h-[44px]" data-testid="select-vaccine-name">
                                <SelectValue placeholder="Select vaccine" />
                              </SelectTrigger>
                              <SelectContent>
                                {vaccineStandards.map(vs => (
                                  <SelectItem key={vs.id} value={vs.vaccineName}>
                                    {vs.vaccineName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label>Batch Number</Label>
                            <Input
                              value={vaccinationForm.batchNumber}
                              onChange={(e) => setVaccinationForm(prev => ({ ...prev, batchNumber: e.target.value }))}
                              placeholder="Vaccine batch number"
                              className="min-h-[44px]"
                              data-testid="input-vaccination-batch"
                            />
                          </div>
                          <div>
                            <Label>Vaccine Make/Brand</Label>
                            <Input
                              value={vaccinationForm.make}
                              onChange={(e) => setVaccinationForm(prev => ({ ...prev, make: e.target.value }))}
                              placeholder="Manufacturer/brand"
                              className="min-h-[44px]"
                              data-testid="input-vaccination-make"
                            />
                          </div>
                          <div>
                            <Label>No. of Birds Vaccinated</Label>
                            <Input
                              type="number"
                              value={vaccinationForm.birdsVaccinated}
                              onChange={(e) => setVaccinationForm(prev => ({ ...prev, birdsVaccinated: e.target.value }))}
                              placeholder="Number of birds"
                              className="min-h-[44px]"
                              data-testid="input-vaccination-birds"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <Label>Vaccinator Count</Label>
                              <Input
                                type="number"
                                value={vaccinationForm.vaccinatorCount}
                                onChange={(e) => setVaccinationForm(prev => ({ ...prev, vaccinatorCount: e.target.value }))}
                                placeholder="No. of vaccinators"
                                className="min-h-[44px]"
                                data-testid="input-vaccinator-count"
                              />
                            </div>
                            <div>
                              <Label>Labours Count</Label>
                              <Input
                                type="number"
                                value={vaccinationForm.laboursCount}
                                onChange={(e) => setVaccinationForm(prev => ({ ...prev, laboursCount: e.target.value }))}
                                placeholder="No. of labours"
                                className="min-h-[44px]"
                                data-testid="input-labours-count"
                              />
                            </div>
                          </div>
                          <div>
                            <Label>Image URL (optional)</Label>
                            <Input
                              value={vaccinationForm.imageUrl}
                              onChange={(e) => setVaccinationForm(prev => ({ ...prev, imageUrl: e.target.value }))}
                              placeholder="URL to vaccination image"
                              className="min-h-[44px]"
                              data-testid="input-vaccination-image"
                            />
                          </div>
                          {(() => {
                            const birdsRaw = vaccinationForm.birdsVaccinated;
                            const birdsNum = Number(birdsRaw);
                            const vaccinatorRaw = vaccinationForm.vaccinatorCount;
                            const vaccinatorNum = Number(vaccinatorRaw);
                            const laboursRaw = vaccinationForm.laboursCount;
                            const laboursNum = Number(laboursRaw);
                            const maxBirds = closingStock;
                            
                            const errors: string[] = [];
                            if (!vaccinationForm.vaccineName) errors.push("Select a vaccine");
                            if (!birdsRaw || birdsNum < 1 || !Number.isInteger(birdsNum)) 
                              errors.push("Birds vaccinated must be a whole number of at least 1");
                            if (birdsRaw && birdsNum > maxBirds) 
                              errors.push(`Birds vaccinated cannot exceed current count (${maxBirds.toLocaleString()})`);
                            if (vaccinatorRaw && (!Number.isInteger(vaccinatorNum) || vaccinatorNum < 0)) 
                              errors.push("Vaccinator count must be a whole number (0 or more)");
                            if (laboursRaw && (!Number.isInteger(laboursNum) || laboursNum < 0)) 
                              errors.push("Labours count must be a whole number (0 or more)");

                            const isValid = errors.length === 0;
                            
                            return (
                              <div className="space-y-2">
                                {errors.length > 0 && (
                                  <div className="text-sm text-destructive space-y-1">
                                    {errors.map((err, i) => <p key={i}>{err}</p>)}
                                  </div>
                                )}
                                <Button 
                                  onClick={handleSaveVaccination}
                                  className="w-full min-h-[44px] bg-yolk-500 hover:bg-yolk-600"
                                  disabled={isSaving || !isValid}
                                  data-testid="button-save-vaccination"
                                >
                                  {isSaving ? 'Saving...' : 'Save Vaccination Record'}
                                </Button>
                              </div>
                            );
                          })()}
                        </div>
                      </DialogContent>
                    </Dialog>
                  </CardHeader>
                  <CardContent>
                    {(shedData.vaccinations as VaccinationRecord[]).length === 0 ? (
                      <div className="text-center py-8 text-muted-foreground">
                        <Syringe className="w-12 h-12 mx-auto mb-4 opacity-50" />
                        <p>No vaccination records yet</p>
                        <p className="text-sm">Click "Add Record" to start tracking vaccinations</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-soil-100">
                              <th className="whitespace-nowrap bg-soil-50 px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Date</th>
                              <th className="whitespace-nowrap bg-soil-50 px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Age</th>
                              <th className="whitespace-nowrap bg-soil-50 px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Vaccine Name</th>
                              <th className="whitespace-nowrap bg-soil-50 px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Batch No.</th>
                              <th className="whitespace-nowrap bg-soil-50 px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-soil-400">Make</th>
                              <th className="whitespace-nowrap bg-soil-50 px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-soil-400">Birds</th>
                              {isAdmin && <th className="whitespace-nowrap bg-soil-50 px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-soil-400">Actions</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {(shedData.vaccinations as VaccinationRecord[]).map(record => {
                              const recordDate = new Date(record.date);
                              const ageRef = shed?.dateOfBirth ? new Date(shed.dateOfBirth) : (earliestStock ? new Date(earliestStock.dateIn) : null);
                              let ageLabel = '-';
                              if (ageRef) {
                                const days = differenceInDays(recordDate, ageRef);
                                if (days < 0) {
                                  ageLabel = '-';
                                } else if (days < 7) {
                                  ageLabel = `Day ${days + 1}`;
                                } else {
                                  ageLabel = `Week ${Math.floor(days / 7) + 1}`;
                                }
                              }
                              return (
                                <tr key={record.id} className="border-b border-soil-100/70 transition-colors hover:bg-yolk-50/70">
                                  <td className="py-3 px-2">{format(recordDate, 'dd MMM yyyy')}</td>
                                  <td className="py-3 px-2">
                                    <Badge variant="outline">{ageLabel}</Badge>
                                  </td>
                                  <td className="py-3 px-2 font-medium">{record.vaccineName}</td>
                                  <td className="py-3 px-2">{record.batchNumber || '-'}</td>
                                  <td className="py-3 px-2">{record.make || '-'}</td>
                                  <td className="py-3 px-2 text-right tabular-nums">{record.birdsVaccinated?.toLocaleString() || '-'}</td>
                                  {isAdmin && (
                                    <td className="py-3 px-2 text-right">
                                      <div className="flex items-center justify-end gap-1">
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8 text-info hover:text-info/80"
                                          onClick={() => handleEditVaccination(record)}
                                          data-testid={`button-edit-vaccination-${record.id}`}
                                        >
                                          <Edit className="w-3.5 h-3.5" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-8 w-8 text-destructive hover:text-destructive/80"
                                          onClick={() => handleDeleteVaccination(record.id)}
                                          data-testid={`button-delete-vaccination-${record.id}`}
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                      </div>
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="batches">
                {/*
                  Batches are not the shed's, and they are not edited here.
                  A batch belongs to the flock: it arrives over several hatches,
                  moves to the layer house over several lorries, and is culled
                  out over several days — and it keeps its record through all of
                  it. A shed is only where it was standing on a given day, which
                  is why daily entry is against the shed but the numbers land on
                  the flock's ledger.

                  So this lists what this house has held and hands off to the
                  flock, where those three things are edited as dated line sets.
                */}
                <Card className="rounded-2xl border-0 bg-white shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)]">
                  <CardHeader className="flex flex-row items-start justify-between gap-3">
                    <div>
                    <CardTitle>Bird Batches</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      What this house has held. A batch keeps its own record across every shed it
                      lives in — open it to see the whole life, and to record hatches, transfers or
                      culling.
                    </p>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {stocks.length === 0 ? (
                      <div className="py-8 text-center text-muted-foreground" data-testid="text-no-batches">
                        No batch has been placed in this house yet.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {stocks.map((stock) => (
                          <button
                            key={stock.id}
                            onClick={() =>
                              stock.flockId && setLocation(`/farms/flocks/${stock.flockId}`)
                            }
                            className="flex w-full items-center justify-between gap-3 rounded-2xl bg-white p-3 text-left shadow-[0_1px_2px_rgba(36,26,16,0.06),0_1px_10px_-4px_rgba(36,26,16,0.08)] transition-colors hover:bg-yolk-50/70"
                            data-testid={`batch-${stock.id}`}
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 font-medium text-foreground">
                                {stock.batchNumber}
                                {stock.isActive === false && (
                                  <Badge variant="secondary" className="text-xs font-normal">
                                    Depleted
                                  </Badge>
                                )}
                              </div>
                              <div className="text-sm text-muted-foreground">
                                Placed: {format(new Date(stock.dateIn), 'dd MMM yyyy')}
                                {stock.batchBirthDate &&
                                  ` | Hatched: ${format(new Date(stock.batchBirthDate), 'dd MMM yyyy')}`}
                              </div>
                            </div>
                            <div className="flex flex-shrink-0 items-center gap-3">
                              <div className="text-right">
                                <div className="text-xs text-muted-foreground">Placed</div>
                                <div className="font-medium tabular-nums text-foreground">
                                  {stock.openingCount.toLocaleString()}
                                </div>
                              </div>
                              <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}

        <Dialog open={showEditShedDialog} onOpenChange={setShowEditShedDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Shed Details</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div>
                <Label>Farm Name</Label>
                <Select
                  value={editShedForm.farmName}
                  onValueChange={(value) => setEditShedForm(prev => ({ ...prev, farmName: value }))}
                >
                  <SelectTrigger className="min-h-[44px]" data-testid="select-edit-farm-name">
                    <SelectValue placeholder="Select farm" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Amino">Amino</SelectItem>
                    <SelectItem value="Nandamuri">Nandamuri</SelectItem>
                    <SelectItem value="Luit Valley">Luit Valley</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Shed Name</Label>
                <Input
                  value={editShedForm.name}
                  onChange={(e) => setEditShedForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Shed A1"
                  className="min-h-[44px]"
                  data-testid="input-edit-shed-name"
                />
              </div>
              <div>
                <Label>Type</Label>
                <Select
                  value={editShedForm.type}
                  onValueChange={(value) => setEditShedForm(prev => ({ ...prev, type: value as 'pullet' | 'layer' }))}
                >
                  <SelectTrigger className="min-h-[44px]" data-testid="select-edit-shed-type">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pullet">Pullet</SelectItem>
                    <SelectItem value="layer">Layer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Display Order</Label>
                <Input
                  type="number"
                  value={editShedForm.displayOrder}
                  onChange={(e) => setEditShedForm(prev => ({ ...prev, displayOrder: parseInt(e.target.value) || 0 }))}
                  className="min-h-[44px]"
                  data-testid="input-edit-shed-order"
                />
              </div>
              <Button
                className="w-full min-h-[44px] bg-yolk-500 hover:bg-yolk-600"
                onClick={handleSaveShedDetails}
                disabled={isSaving || !editShedForm.name}
                data-testid="button-save-shed-details"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>


        {/* Record Detail Dialog */}
        <Dialog open={showRecordDetailDialog} onOpenChange={setShowRecordDetailDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                Daily Record - {selectedRecord ? format(new Date(selectedRecord.date), 'dd MMM yyyy') : ''}
              </DialogTitle>
            </DialogHeader>
            {selectedRecord && (
              <div className="space-y-4 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-destructive/10 p-3 rounded-lg">
                    <div className="text-xs text-destructive mb-1">Mortality</div>
                    <div className="text-lg font-semibold text-destructive">{selectedRecord.mortality || 0}</div>
                  </div>
                  <div className="bg-soil-100 p-3 rounded-lg">
                    <div className="text-xs text-soil-600 mb-1">Male Birds</div>
                    <div className="text-lg font-semibold text-soil-800">{selectedRecord.maleBirds || 0}</div>
                  </div>
                  <div className="bg-soil-100 p-3 rounded-lg">
                    <div className="text-xs text-soil-600 mb-1">Birds Culled</div>
                    <div className="text-lg font-semibold text-soil-800">{selectedRecord.birdsCulled || 0}</div>
                  </div>
                  {shed?.type === 'layer' && (
                    <div className="bg-yolk-100 p-3 rounded-lg">
                      <div className="text-xs text-yolk-700 mb-1">Eggs Produced</div>
                      <div className="text-lg font-semibold text-yolk-700">{(selectedRecord.eggsProduced || 0).toLocaleString()}</div>
                    </div>
                  )}
                </div>
                
                <div className="border-t pt-3">
                  <h4 className="text-sm font-medium mb-2">Transfers</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-success/10 p-3 rounded-lg">
                      <div className="text-xs text-success mb-1 flex items-center gap-1">
                        <ArrowDownRight className="w-3 h-3" /> Transferred In
                      </div>
                      <div className="text-lg font-semibold text-success">{selectedRecord.birdsTransferredIn || 0}</div>
                    </div>
                    <div className="bg-warning/10 p-3 rounded-lg">
                      <div className="text-xs text-warning mb-1 flex items-center gap-1">
                        <ArrowUpRight className="w-3 h-3" /> Transferred Out
                      </div>
                      <div className="text-lg font-semibold text-warning">{selectedRecord.birdsTransferredOut || 0}</div>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-3">
                  <h4 className="text-sm font-medium mb-2">Water</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-soil-100 p-3 rounded-lg">
                      <div className="text-xs text-soil-600 mb-1">Upper Tank (KL)</div>
                      <div className="text-lg font-semibold text-soil-800">{selectedRecord.waterUpperKl || 0}</div>
                    </div>
                    <div className="bg-soil-100 p-3 rounded-lg">
                      <div className="text-xs text-soil-600 mb-1">Lower Tank (KL)</div>
                      <div className="text-lg font-semibold text-soil-800">{selectedRecord.waterLowerKl || 0}</div>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-3">
                  <h4 className="text-sm font-medium mb-2">Feed</h4>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-yolk-50 p-3 rounded-lg">
                      <div className="text-xs text-yolk-700 mb-1">Delivered (kg)</div>
                      <div className="text-lg font-semibold text-yolk-700">{selectedRecord.feedDeliveredKg || 0}</div>
                    </div>
                    <div className="bg-yolk-50 p-3 rounded-lg">
                      <div className="text-xs text-yolk-700 mb-1">Intake (kg)</div>
                      <div className="text-lg font-semibold text-yolk-700">{selectedRecord.feedIntakeKg || 0}</div>
                    </div>
                    <div className="bg-yolk-50 p-3 rounded-lg">
                      <div className="text-xs text-yolk-700 mb-1">Stock (kg)</div>
                      <div className="text-lg font-semibold text-yolk-700">{selectedRecord.feedStockKg || 0}</div>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-3 text-sm text-gray-500">
                  Recorded by: {selectedRecord.recordedBy}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

// The farm's shed screen ends with a live-sensor card here — the Big Herdsman
// house card, fed by controller readings. It is not ported because niko has no
// IoT integration at all: no polling, no readings table, nothing behind it.
// That is a subsystem rather than a component, so it wants its own decision.
