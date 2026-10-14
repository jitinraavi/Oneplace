'use client';

import React, { useState } from 'react';

export interface ParcelSummary {
  id: string;
  apn: string;
  fipsCode: string;
  situsAddress: string;
  city: string;
  stateCode: string;
  lotSizeAcres: number;
  buildingSqft: number | null;
  zoningCode: string;
  totalAssessedValueCents: number;
  annualTaxAmountCents: number;
  ownerOfRecordName: string;
  isOwnerVerified: boolean;
  messageGateStatus: 'NONE' | 'PENDING' | 'ACCEPTED' | 'DECLINED';
  activeAuction?: {
    id: string;
    status: 'LIVE' | 'EXTENDED';
    highestBidCents: number;
    minIncrementCents: number;
    entryFeeCents: number;
    endsAt: string;
    isBidderQualified: boolean;
  };
}

export const OnePlaceExplorer: React.FC<{ selectedParcel: ParcelSummary }> = ({
  selectedParcel,
}) => {
  const [viewMode, setViewMode] = useState<'2D_PARCEL' | '3D_EARTH'>('3D_EARTH');
  const [activeTab, setActiveTab] = useState<'COUNTY_RECORD' | 'DIRECT_OFFER' | 'AUCTION'>(
    selectedParcel.activeAuction ? 'AUCTION' : 'COUNTY_RECORD',
  );
  const [offerPrice, setOfferPrice] = useState<string>('');
  const [introNote, setIntroNote] = useState<string>('');
  const [termsAccepted, setTermsAccepted] = useState<boolean>(false);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans">
      <header className="absolute top-4 left-4 z-20 flex items-center gap-3 rounded-2xl border border-slate-800/80 bg-slate-900/85 px-4 py-2.5 backdrop-blur-md shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-indigo-500 ring-4 ring-indigo-500/20" />
          <span className="text-lg font-bold tracking-tight text-white">One Place</span>
        </div>
        <div className="h-4 w-px bg-slate-800" />
        <div className="flex rounded-lg bg-slate-950 p-1 text-xs font-medium">
          <button
            onClick={() => setViewMode('2D_PARCEL')}
            className={`rounded-md px-3 py-1 transition ${
              viewMode === '2D_PARCEL' ? 'bg-indigo-600 text-white' : 'text-slate-400'
            }`}
          >
            2D Parcel Map
          </button>
          <button
            onClick={() => setViewMode('3D_EARTH')}
            className={`rounded-md px-3 py-1 transition ${
              viewMode === '3D_EARTH' ? 'bg-indigo-600 text-white' : 'text-slate-400'
            }`}
          >
            3D Google Earth
          </button>
        </div>
      </header>

      <aside className="ml-auto z-20 flex h-full w-full max-w-md flex-col border-l border-slate-800/80 bg-slate-900/95 backdrop-blur-xl shadow-2xl">
        <div className="border-b border-slate-800 p-5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs uppercase tracking-wider text-indigo-400">
              APN: {selectedParcel.apn} • FIPS {selectedParcel.fipsCode}
            </span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                selectedParcel.isOwnerVerified
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
              }`}
            >
              {selectedParcel.isOwnerVerified ? 'Verified Owner' : 'County Record'}
            </span>
          </div>
          <h1 className="mt-2 text-xl font-bold text-white">{selectedParcel.situsAddress}</h1>
          <p className="text-sm text-slate-400">
            {selectedParcel.city}, {selectedParcel.stateCode} • {selectedParcel.lotSizeAcres} Acres •{' '}
            Zoning {selectedParcel.zoningCode}
          </p>
        </div>

        <div className="grid grid-cols-3 border-b border-slate-800 text-xs font-semibold uppercase tracking-wider">
          <button
            onClick={() => setActiveTab('COUNTY_RECORD')}
            className={`py-3 border-b-2 ${
              activeTab === 'COUNTY_RECORD'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400'
            }`}
          >
            County Record
          </button>
          <button
            onClick={() => setActiveTab('DIRECT_OFFER')}
            className={`py-3 border-b-2 ${
              activeTab === 'DIRECT_OFFER'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-slate-400'
            }`}
          >
            Offer & Message
          </button>
          <button
            onClick={() => setActiveTab('AUCTION')}
            className={`py-3 border-b-2 ${
              activeTab === 'AUCTION'
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-slate-400'
            }`}
          >
            Live Bidding
          </button>
        </div>

        {activeTab === 'COUNTY_RECORD' && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
                <span className="text-xs text-slate-400">County Assessed Value</span>
                <p className="mt-1 font-mono text-lg font-bold text-white">
                  ${(selectedParcel.totalAssessedValueCents / 100).toLocaleString()}
                </p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
                <span className="text-xs text-slate-400">Annual Property Tax</span>
                <p className="mt-1 font-mono text-lg font-bold text-white">
                  ${(selectedParcel.annualTaxAmountCents / 100).toLocaleString()}/yr
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Owner of Record</span>
                <span className="font-medium text-white">{selectedParcel.ownerOfRecordName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Building Area</span>
                <span className="font-mono text-white">
                  {selectedParcel.buildingSqft
                    ? `${selectedParcel.buildingSqft.toLocaleString()} sq ft`
                    : 'Vacant Land'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Direct Contact Info</span>
                <span className="text-xs text-amber-400">Protected by One Place Gate</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'DIRECT_OFFER' && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {selectedParcel.messageGateStatus === 'ACCEPTED' ? (
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300">
                Owner accepted your request! Full encrypted negotiation chat is now unlocked.
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200 leading-relaxed">
                  <strong>Owner Privacy Gate:</strong> You can send one structured purchase offer
                  and message request. Direct two-way chat unlocks only if the owner accepts your
                  request.
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300">
                    Proposed Offer Price (USD)
                  </label>
                  <input
                    type="number"
                    value={offerPrice}
                    onChange={(e) => setOfferPrice(e.target.value)}
                    placeholder="e.g., 850000"
                    className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 font-mono text-sm text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300">
                    Message to Property Owner
                  </label>
                  <textarea
                    rows={4}
                    value={introNote}
                    onChange={(e) => setIntroNote(e.target.value)}
                    placeholder="State your intended terms, Proof of Funds status, and closing timeline..."
                    className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3.5 text-sm text-white"
                  />
                </div>
                <button className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 transition">
                  Send Offer & Message Request
                </button>
              </>
            )}
          </div>
        )}

        {activeTab === 'AUCTION' && (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {selectedParcel.activeAuction ? (
              <>
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4">
                  <span className="text-xs uppercase tracking-wider text-emerald-400 font-semibold">
                    Live Property Auction
                  </span>
                  <p className="mt-1 font-mono text-2xl font-bold text-white">
                    ${(selectedParcel.activeAuction.highestBidCents / 100).toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Min Increment: $
                    {(selectedParcel.activeAuction.minIncrementCents / 100).toLocaleString()} • Entry
                    Fee: ${(selectedParcel.activeAuction.entryFeeCents / 100).toLocaleString()}
                  </p>
                </div>

                {!selectedParcel.activeAuction.isBidderQualified ? (
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-white">
                      Unlock Bidding (Entry Fee & Terms)
                    </h3>
                    <label className="flex items-start gap-2.5 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={termsAccepted}
                        onChange={(e) => setTermsAccepted(e.target.checked)}
                        className="mt-0.5 rounded border-slate-700"
                      />
                      <span>
                        I have reviewed and digitally sign the Seller&apos;s Property Terms &
                        Conditions (SHA-256 recorded) and authorize the $
                        {(selectedParcel.activeAuction.entryFeeCents / 100).toLocaleString()} entry
                        fee hold.
                      </span>
                    </label>
                    <button
                      disabled={!termsAccepted}
                      className="w-full rounded-xl bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-500 py-3 text-sm font-semibold text-white transition"
                    >
                      Pay Entry Fee & Unlock Bidding
                    </button>
                  </div>
                ) : (
                  <button className="w-full rounded-xl bg-emerald-600 py-3.5 text-sm font-bold text-white hover:bg-emerald-500 transition">
                    Place Next Bid ($
                    {(
                      (selectedParcel.activeAuction.highestBidCents +
                        selectedParcel.activeAuction.minIncrementCents) /
                      100
                    ).toLocaleString()}
                    )
                  </button>
                )}
              </>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-400">
                No active auction on this parcel. Use the <strong>Offer & Message</strong> tab to
                send a direct purchase offer to the owner.
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
};
