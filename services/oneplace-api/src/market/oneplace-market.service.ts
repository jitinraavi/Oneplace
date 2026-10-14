import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

@Injectable()
export class OnePlaceMarketService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: Redis,
  ) {}

  /**
   * WORKFLOW 1: Owner responds to a Buyer's Request-Gated Offer/Message
   * Chat remains strictly locked unless the verified owner transitions status to 'ACCEPTED'.
   */
  async respondToMessageRequest(params: {
    ownerUserId: string;
    requestId: string;
    decision: 'ACCEPTED' | 'DECLINED';
  }) {
    return this.dataSource.transaction(async (manager) => {
      const request = await manager.query(
        `SELECT mr.id, mr.status, mr.parcel_id, p.verified_owner_user_id
         FROM message_requests mr
         JOIN parcels p ON p.id = mr.parcel_id
         WHERE mr.id = $1
         FOR UPDATE`,
        [params.requestId],
      );

      if (!request.length) {
        throw new BadRequestException('Message request not found.');
      }

      const record = request[0];

      if (record.verified_owner_user_id !== params.ownerUserId) {
        throw new ForbiddenException(
          'Only the verified parcel owner of record can accept or decline offer requests.',
        );
      }

      if (record.status !== 'PENDING') {
        throw new ConflictException(`Request is already ${record.status}.`);
      }

      await manager.query(
        `UPDATE message_requests
         SET status = $1, owner_user_id = $2, responded_at = NOW()
         WHERE id = $3`,
        [params.decision, params.ownerUserId, params.requestId],
      );

      return {
        requestId: params.requestId,
        status: params.decision,
        chatUnlocked: params.decision === 'ACCEPTED',
      };
    });
  }

  /**
   * WORKFLOW 2: Send Message inside an Accepted Thread
   */
  async sendGatedMessage(params: {
    senderUserId: string;
    requestId: string;
    plaintextMessage: string;
    counterOfferCents?: number;
  }) {
    // Strip off-platform contact evasion patterns (phone/email leakage before escrow)
    const sanitized = params.plaintextMessage.replace(
      /(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
      '[PHONE REDACTED BY ONE PLACE SECURITY]',
    );

    return this.dataSource.transaction(async (manager) => {
      const threads = await manager.query(
        `SELECT id, buyer_user_id, owner_user_id, status
         FROM message_requests
         WHERE id = $1`,
        [params.requestId],
      );

      if (!threads.length) {
        throw new BadRequestException('Thread not found.');
      }

      const thread = threads[0];
      const isParticipant =
        params.senderUserId === thread.buyer_user_id ||
        params.senderUserId === thread.owner_user_id;

      if (!isParticipant) {
        throw new ForbiddenException('You are not a participant in this parcel thread.');
      }

      if (thread.status !== 'ACCEPTED') {
        throw new ForbiddenException(
          'Messaging is locked until the property owner accepts the initial offer request.',
        );
      }

      const result = await manager.query(
        `INSERT INTO messages (message_request_id, sender_user_id, body_ciphertext, counter_offer_price_cents)
         VALUES ($1, $2, pgp_sym_encrypt($3, current_setting('app.encryption_key')), $4)
         RETURNING id, created_at`,
        [
          params.requestId,
          params.senderUserId,
          sanitized,
          params.counterOfferCents ?? null,
        ],
      );

      return result[0];
    });
  }

  /**
   * WORKFLOW 3: Qualify Bidder (Verify Cryptographic T&C Signature + Entry Fee Hold)
   */
  async verifyTermsAndQualifyBidder(params: {
    auctionId: string;
    bidderUserId: string;
    submittedTermsText: string;
    stripePaymentIntentId: string;
    entryFeeAuthorized: boolean;
    signerIp: string;
    userAgent: string;
    deviceFingerprint: string;
  }) {
    const computedHash = createHash('sha256')
      .update(params.submittedTermsText, 'utf8')
      .digest('hex');

    return this.dataSource.transaction(async (manager) => {
      const termsRows = await manager.query(
        `SELECT id, terms_sha256_hash
         FROM auction_terms
         WHERE auction_id = $1
         ORDER BY version DESC
         LIMIT 1`,
        [params.auctionId],
      );

      if (!termsRows.length) {
        throw new BadRequestException('Auction terms not found.');
      }

      const activeTerms = termsRows[0];

      if (activeTerms.terms_sha256_hash !== computedHash) {
        throw new ForbiddenException(
          'Terms & Conditions hash mismatch. Please review the latest property terms.',
        );
      }

      if (!params.entryFeeAuthorized) {
        throw new ForbiddenException('Entry fee authorization is required before bidding.');
      }

      const qual = await manager.query(
        `INSERT INTO bidder_qualifications (
          auction_id, bidder_user_id, auction_terms_id, accepted_terms_sha256,
          signer_ip_address, signer_user_agent, signer_device_fingerprint,
          stripe_payment_intent_id, entry_fee_status, qualified_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AUTHORIZED_HOLD', NOW())
        ON CONFLICT (auction_id, bidder_user_id)
        DO UPDATE SET entry_fee_status = 'AUTHORIZED_HOLD', qualified_at = NOW()
        RETURNING id, qualified_at`,
        [
          params.auctionId,
          params.bidderUserId,
          activeTerms.id,
          computedHash,
          params.signerIp,
          params.userAgent,
          params.deviceFingerprint,
          params.stripePaymentIntentId,
        ],
      );

      return qual[0];
    });
  }

  /**
   * WORKFLOW 4: Atomic Bid Placement with Anti-Sniping Soft Close & Audit Hash Chain
   */
  async placeAtomicBid(params: {
    auctionId: string;
    bidderUserId: string;
    bidAmountCents: number;
    idempotencyKey: string;
    sourceIp: string;
    deviceFingerprint: string;
  }) {
    const lockKey = `oneplace:lock:auction:${params.auctionId}`;
    const lockToken = await this.redis.set(lockKey, params.idempotencyKey, 'PX', 5000, 'NX');

    if (!lockToken) {
      throw new ConflictException('High bidding activity on this parcel—please retry in a moment.');
    }

    try {
      return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
        const auctions = await manager.query(
          `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
          [params.auctionId],
        );

        if (!auctions.length) {
          throw new BadRequestException('Auction not found.');
        }

        const auction = auctions[0];
        const now = new Date();

        // Anti-shill bidding check: Seller cannot bid on their own parcel
        if (auction.seller_user_id === params.bidderUserId) {
          throw new ForbiddenException('Property owners cannot bid on their own auction.');
        }

        if (!['LIVE', 'EXTENDED'].includes(auction.status) || now >= new Date(auction.ends_at)) {
          throw new BadRequestException('This One Place property auction has ended or is not active.');
        }

        // Verify Bidder Qualification (Signed T&C + Confirmed Entry Fee Hold)
        const quals = await manager.query(
          `SELECT id, signer_device_fingerprint
           FROM bidder_qualifications
           WHERE auction_id = $1 AND bidder_user_id = $2 AND entry_fee_status IN ('AUTHORIZED_HOLD', 'CAPTURED')`,
          [params.auctionId, params.bidderUserId],
        );

        if (!quals.length) {
          throw new ForbiddenException(
            'You must accept the Property Terms & Conditions and pay the entry fee before bidding.',
          );
        }

        const minRequiredCents = auction.highest_bid_cents
          ? Number(auction.highest_bid_cents) + Number(auction.min_increment_cents)
          : Number(auction.starting_bid_cents);

        if (params.bidAmountCents < minRequiredCents) {
          throw new BadRequestException(
            `Minimum valid bid is $${(minRequiredCents / 100).toLocaleString()}.`,
          );
        }

        // Compute tamper-evident hash chain
        const prevBids = await manager.query(
          `SELECT record_hash FROM bids WHERE auction_id = $1 ORDER BY server_received_at DESC LIMIT 1`,
          [params.auctionId],
        );

        const prevHash = prevBids.length ? prevBids[0].record_hash : 'GENESIS_BID';
        const recordHash = createHash('sha256')
          .update(
            `${prevHash}|${params.auctionId}|${params.bidderUserId}|${params.bidAmountCents}|${params.idempotencyKey}`,
          )
          .digest('hex');

        const insertedBid = await manager.query(
          `INSERT INTO bids (
            auction_id, bidder_user_id, qualification_id, bid_amount_cents,
            idempotency_key, source_ip, device_fingerprint, prev_bid_hash, record_hash
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, server_received_at`,
          [
            params.auctionId,
            params.bidderUserId,
            quals[0].id,
            params.bidAmountCents,
            params.idempotencyKey,
            params.sourceIp,
            params.deviceFingerprint,
            prevHash,
            recordHash,
          ],
        );

        // Evaluate Anti-Sniping Soft Close Window
        const endsAtMs = new Date(auction.ends_at).getTime();
        const remainingSeconds = (endsAtMs - now.getTime()) / 1000;
        let newEndsAt = new Date(auction.ends_at);
        let newStatus = auction.status;

        if (remainingSeconds <= auction.soft_close_window_seconds) {
          newEndsAt = new Date(endsAtMs + auction.soft_close_extension_seconds * 1000);
          newStatus = 'EXTENDED';
        }

        await manager.query(
          `UPDATE auctions
           SET highest_bid_id = $1, highest_bid_cents = $2, ends_at = $3, status = $4
           WHERE id = $5`,
          [
            insertedBid[0].id,
            params.bidAmountCents,
            newEndsAt.toISOString(),
            newStatus,
            params.auctionId,
          ],
        );

        return {
          bidId: insertedBid[0].id,
          bidAmountCents: params.bidAmountCents,
          auctionEndsAt: newEndsAt.toISOString(),
          extendedByAntiSniping: newStatus === 'EXTENDED',
          auditRecordHash: recordHash,
        };
      });
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
