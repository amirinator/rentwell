/**
 * Every GraphQL document the client sends.
 *
 * Kept in one file on purpose: it is the complete list of what this client asks
 * for, which makes it easy to check that no screen is over-fetching and that
 * every financial mutation sends the version it saw.
 */

import { gql } from '@apollo/client';

// --------------------------------------------------------------------------
// Fragments
// --------------------------------------------------------------------------

export const MONEY_FIELDS = gql`
  fragment MoneyFields on Money {
    cents
    currency
    formatted
  }
`;

export const PAGE_INFO_FIELDS = gql`
  fragment PageInfoFields on PageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
`;

export const CHARGE_FIELDS = gql`
  ${MONEY_FIELDS}
  fragment ChargeFields on Charge {
    id
    type
    status
    description
    amount {
      ...MoneyFields
    }
    allocatedAmount {
      ...MoneyFields
    }
    creditedAmount {
      ...MoneyFields
    }
    openBalance {
      ...MoneyFields
    }
    serviceStart
    serviceEnd
    dueDate
    period
    daysPastDue
    version
    tenant {
      id
      displayName
      paymentReference
    }
  }
`;

export const TRANSACTION_FIELDS = gql`
  ${MONEY_FIELDS}
  fragment TransactionFields on BankTransaction {
    id
    externalId
    source
    status
    direction
    amount {
      ...MoneyFields
    }
    allocatedAmount {
      ...MoneyFields
    }
    unappliedAmount {
      ...MoneyFields
    }
    postedDate
    period
    reference
    description
    reversedAt
    version
  }
`;

export const EXCEPTION_FIELDS = gql`
  ${MONEY_FIELDS}
  fragment ExceptionFields on ReconciliationException {
    id
    category
    status
    severity
    summary
    isBlocking
    openAmount {
      ...MoneyFields
    }
    period
    resolution
    resolutionReason
    reopenCount
    createdAt
    version
    assignedTo {
      userId
      displayName
    }
  }
`;

// --------------------------------------------------------------------------
// Session
// --------------------------------------------------------------------------

export const VIEWER = gql`
  query Viewer {
    viewer {
      id
      email
      displayName
      role
      assignedPropertyIds
      permissions
      organization {
        id
        name
        slug
        currency
      }
    }
  }
`;

export const SIGN_IN = gql`
  mutation SignIn($input: SignInInput!) {
    signIn(input: $input) {
      csrfToken
      viewer {
        id
        email
        displayName
        role
        assignedPropertyIds
        permissions
        organization {
          id
          name
          slug
          currency
        }
      }
    }
  }
`;

export const SIGN_OUT = gql`
  mutation SignOut {
    signOut
  }
`;

export const MEMBERS = gql`
  query Members {
    members {
      id
      userId
      email
      displayName
      role
      status
      assignedProperties {
        id
        code
        name
      }
    }
  }
`;

// --------------------------------------------------------------------------
// Dashboard
// --------------------------------------------------------------------------

export const PORTFOLIO_SUMMARY = gql`
  ${MONEY_FIELDS}
  query PortfolioSummary($filter: PortfolioFilter!) {
    portfolioSummary(filter: $filter) {
      period
      asOfDate
      refreshedAt
      chargesPosted {
        ...MoneyFields
      }
      paymentsReceived {
        ...MoneyFields
      }
      paymentsAllocated {
        ...MoneyFields
      }
      unappliedCash {
        ...MoneyFields
      }
      outstandingReceivables {
        ...MoneyFields
      }
      allocationRate
      suggestionCoverage
      aging {
        label
        minDaysPastDue
        maxDaysPastDue
        chargeCount
        amount {
          ...MoneyFields
        }
      }
      exceptionsBySeverity {
        key
        label
        count
        amount {
          ...MoneyFields
        }
      }
      exceptionsByOwner {
        key
        label
        count
        amount {
          ...MoneyFields
        }
      }
      closeStatus {
        period
        status
        blockerCount
        property {
          id
          code
          name
        }
      }
      processing {
        failedImports
        importsInProgress
        pendingOutboxEvents
        oldestPendingEventAgeSeconds
        deadLetterEvents
      }
      metricNotes {
        metric
        dateBasis
        reversalTreatment
        filters
      }
    }
  }
`;

// --------------------------------------------------------------------------
// Portfolio
// --------------------------------------------------------------------------

export const PROPERTIES = gql`
  ${MONEY_FIELDS}
  ${PAGE_INFO_FIELDS}
  query Properties($first: Int, $after: String, $search: String) {
    properties(first: $first, after: $after, search: $search) {
      totalCount
      pageInfo {
        ...PageInfoFields
      }
      edges {
        cursor
        node {
          id
          code
          name
          city
          region
          status
          currency
          unitCount
          activeLeaseCount
          openExceptionCount
          outstandingReceivables {
            ...MoneyFields
          }
          unappliedCash {
            ...MoneyFields
          }
        }
      }
    }
  }
`;

export const PROPERTY_DETAIL = gql`
  ${MONEY_FIELDS}
  query PropertyDetail($id: ID!, $period: Period!) {
    property(id: $id) {
      id
      code
      name
      addressLine1
      city
      region
      postalCode
      timezone
      currency
      status
      unitCount
      activeLeaseCount
      outstandingReceivables {
        ...MoneyFields
      }
      unappliedCash {
        ...MoneyFields
      }
      bankAccounts {
        id
        label
        maskedNumber
        currency
        isActive
      }
      period(period: $period) {
        id
        period
        status
        version
        closedAt
        reopenCount
      }
      units(first: 50) {
        totalCount
        edges {
          node {
            id
            identifier
            floor
            rentableArea
            occupancy
            currentLease {
              id
              reference
              status
              tenant {
                id
                displayName
              }
            }
          }
        }
      }
    }
  }
`;

export const LEASE_DETAIL = gql`
  ${MONEY_FIELDS}
  query LeaseDetail($id: ID!) {
    lease(id: $id) {
      id
      reference
      status
      currency
      termStart
      termEnd
      paymentReference
      version
      outstandingBalance {
        ...MoneyFields
      }
      property {
        id
        code
        name
      }
      unit {
        id
        identifier
      }
      tenant {
        id
        displayName
        paymentReference
        contactEmail
      }
      schedules {
        id
        chargeType
        frequency
        description
        isActive
        versions {
          id
          versionNumber
          effectiveFrom
          effectiveTo
          dueDayOfMonth
          prorate
          note
          amount {
            ...MoneyFields
          }
        }
      }
      amendments {
        id
        summary
        effectiveOn
        createdAt
      }
    }
  }
`;

export const RECEIVABLES = gql`
  ${CHARGE_FIELDS}
  ${MONEY_FIELDS}
  ${PAGE_INFO_FIELDS}
  query Receivables($filter: ReceivableFilter!, $first: Int, $after: String) {
    receivables(filter: $filter, first: $first, after: $after) {
      totalCount
      pageInfo {
        ...PageInfoFields
      }
      totals {
        charged {
          ...MoneyFields
        }
        allocated {
          ...MoneyFields
        }
        credited {
          ...MoneyFields
        }
        outstanding {
          ...MoneyFields
        }
      }
      edges {
        cursor
        node {
          ...ChargeFields
        }
      }
    }
  }
`;

// --------------------------------------------------------------------------
// Charge generation
// --------------------------------------------------------------------------

export const PREVIEW_CHARGES = gql`
  ${MONEY_FIELDS}
  mutation PreviewCharges($input: PreviewChargesInput!) {
    previewCharges(input: $input) {
      period
      propertyId
      leaseCount
      skippedKeys
      totalAmount {
        ...MoneyFields
      }
      warnings {
        code
        message
        leaseId
        scheduleId
      }
      proposed {
        generationKey
        type
        description
        serviceStart
        serviceEnd
        dueDate
        calculation
        amount {
          ...MoneyFields
        }
        tenant {
          id
          displayName
        }
        lease {
          id
          reference
        }
      }
    }
  }
`;

export const GENERATE_CHARGES = gql`
  ${CHARGE_FIELDS}
  ${MONEY_FIELDS}
  mutation GenerateCharges($input: GenerateChargesInput!) {
    generateCharges(input: $input) {
      period
      propertyId
      createdCount
      skippedCount
      totalAmount {
        ...MoneyFields
      }
      warnings {
        code
        message
      }
      charges {
        ...ChargeFields
      }
    }
  }
`;

export const CREATE_CREDIT = gql`
  ${CHARGE_FIELDS}
  mutation CreateCredit($input: CreateCreditInput!) {
    createCreditAdjustment(input: $input) {
      ...ChargeFields
    }
  }
`;

// --------------------------------------------------------------------------
// Imports
// --------------------------------------------------------------------------

export const IMPORTS = gql`
  ${PAGE_INFO_FIELDS}
  query Imports($filter: ImportFilter, $first: Int, $after: String) {
    imports(filter: $filter, first: $first, after: $after) {
      totalCount
      pageInfo {
        ...PageInfoFields
      }
      edges {
        cursor
        node {
          id
          status
          originalFilename
          totalRows
          processedRows
          createdRows
          duplicateRows
          failedRows
          checkpointRow
          errorMessage
          attempts
          createdAt
          completedAt
          property {
            id
            code
          }
          bankAccount {
            id
            label
          }
        }
      }
    }
  }
`;

export const IMPORT_DETAIL = gql`
  query ImportDetail($id: ID!) {
    importBatch(id: $id) {
      id
      status
      originalFilename
      fileHash
      fileSizeBytes
      totalRows
      processedRows
      createdRows
      duplicateRows
      failedRows
      checkpointRow
      attempts
      errorMessage
      createdAt
      confirmedAt
      completedAt
      downloadUrl
      validationErrors {
        rowNumber
        column
        code
        message
        value
      }
      property {
        id
        code
        name
      }
      bankAccount {
        id
        label
        currency
      }
      rows(first: 50) {
        totalCount
        edges {
          node {
            id
            rowNumber
            externalId
            outcome
            message
          }
        }
      }
    }
  }
`;

export const CREATE_IMPORT_UPLOAD = gql`
  mutation CreateImportUpload($input: CreateImportInput!) {
    createImportUpload(input: $input) {
      importId
      uploadUrl
      storageKey
      expiresAt
    }
  }
`;

export const VALIDATE_IMPORT = gql`
  mutation ValidateImport($importId: ID!) {
    validateImport(importId: $importId) {
      importId
      status
      totalRows
      validRows
      fileHash
      errors {
        rowNumber
        column
        code
        message
        value
      }
    }
  }
`;

export const CONFIRM_IMPORT = gql`
  mutation ConfirmImport($input: ConfirmImportInput!) {
    confirmImport(input: $input) {
      id
      status
      totalRows
      checkpointRow
    }
  }
`;

export const CANCEL_IMPORT = gql`
  mutation CancelImport($importId: ID!) {
    cancelImport(importId: $importId) {
      id
      status
    }
  }
`;

export const RETRY_IMPORT = gql`
  mutation RetryImport($importId: ID!) {
    retryImport(importId: $importId) {
      id
      status
      checkpointRow
    }
  }
`;

// --------------------------------------------------------------------------
// Reconciliation
// --------------------------------------------------------------------------

export const TRANSACTIONS = gql`
  ${TRANSACTION_FIELDS}
  ${MONEY_FIELDS}
  ${PAGE_INFO_FIELDS}
  query Transactions($filter: TransactionFilter!, $first: Int, $after: String) {
    transactions(filter: $filter, first: $first, after: $after) {
      totalCount
      pageInfo {
        ...PageInfoFields
      }
      totals {
        received {
          ...MoneyFields
        }
        allocated {
          ...MoneyFields
        }
        unapplied {
          ...MoneyFields
        }
      }
      edges {
        cursor
        node {
          ...TransactionFields
          property {
            id
            code
          }
          exception {
            id
            category
            severity
          }
        }
      }
    }
  }
`;

export const TRANSACTION_WORKBENCH = gql`
  ${TRANSACTION_FIELDS}
  ${CHARGE_FIELDS}
  ${MONEY_FIELDS}
  query TransactionWorkbench($id: ID!) {
    transaction(id: $id) {
      ...TransactionFields
      property {
        id
        code
        name
        currency
      }
      bankAccount {
        id
        label
        maskedNumber
      }
      allocations {
        id
        status
        postingDate
        note
        amount {
          ...MoneyFields
        }
        charge {
          id
          description
          dueDate
        }
        approvedBy {
          userId
          displayName
        }
        reversal {
          id
          reason
          createdAt
        }
      }
      suggestions {
        id
        strategy
        status
        score
        ruleVersion
        isStale
        warnings
        generatedAt
        scoreComponents {
          referencePoints
          amountPoints
          datePoints
          descriptionPoints
          totalPoints
        }
        evidence {
          kind
          label
          recordIds
          contribution
        }
        totalAmount {
          ...MoneyFields
        }
        remainder {
          ...MoneyFields
        }
        lines {
          amount {
            ...MoneyFields
          }
          charge {
            ...ChargeFields
          }
        }
      }
      exception {
        id
        category
        severity
        status
        summary
      }
    }
  }
`;

export const APPROVE_ALLOCATIONS = gql`
  ${TRANSACTION_FIELDS}
  ${MONEY_FIELDS}
  mutation ApproveAllocations($input: ApproveAllocationsInput!) {
    approveAllocations(input: $input) {
      totalAllocated {
        ...MoneyFields
      }
      remainingUnapplied {
        ...MoneyFields
      }
      transaction {
        ...TransactionFields
      }
      allocations {
        id
        status
        amount {
          ...MoneyFields
        }
      }
      exception {
        id
        category
        status
      }
    }
  }
`;

export const REVERSE_ALLOCATION = gql`
  ${TRANSACTION_FIELDS}
  ${CHARGE_FIELDS}
  mutation ReverseAllocation($input: ReverseAllocationInput!) {
    reverseAllocation(input: $input) {
      allocation {
        id
        status
      }
      transaction {
        ...TransactionFields
      }
      charge {
        ...ChargeFields
      }
    }
  }
`;

export const REGENERATE_SUGGESTIONS = gql`
  mutation RegenerateSuggestions($input: RegenerateSuggestionsInput!) {
    regenerateSuggestions(input: $input) {
      id
      strategy
      score
      isStale
    }
  }
`;

// --------------------------------------------------------------------------
// Exceptions
// --------------------------------------------------------------------------

export const EXCEPTIONS = gql`
  ${EXCEPTION_FIELDS}
  ${PAGE_INFO_FIELDS}
  query Exceptions($filter: ExceptionFilter!, $first: Int, $after: String) {
    exceptions(filter: $filter, first: $first, after: $after) {
      totalCount
      pageInfo {
        ...PageInfoFields
      }
      edges {
        cursor
        node {
          ...ExceptionFields
          property {
            id
            code
          }
          transaction {
            id
            reference
            postedDate
          }
        }
      }
    }
  }
`;

export const EXCEPTION_DETAIL = gql`
  ${EXCEPTION_FIELDS}
  ${CHARGE_FIELDS}
  ${TRANSACTION_FIELDS}
  query ExceptionDetail($id: ID!) {
    exception(id: $id) {
      ...ExceptionFields
      property {
        id
        code
        name
      }
      tenant {
        id
        displayName
        paymentReference
      }
      transaction {
        ...TransactionFields
        allocations {
          id
          status
          amount {
            cents
            currency
            formatted
          }
        }
      }
      candidateCharges {
        ...ChargeFields
      }
      comments {
        id
        body
        authorName
        createdAt
      }
      assistantRuns {
        id
        status
        provider
        model
        promptVersion
        errorCode
        errorMessage
        durationMs
        startedAt
        completedAt
        analysis {
          summary
          possibleExplanations
          recommendedNextSteps
          missingInformation
          supportingRecords {
            recordType
            recordId
            label
          }
        }
        toolCalls {
          sequence
          toolName
          allowed
          denialReason
          resultSummary
        }
      }
    }
  }
`;

export const ASSIGN_EXCEPTION = gql`
  ${EXCEPTION_FIELDS}
  mutation AssignException($input: AssignExceptionInput!) {
    assignException(input: $input) {
      ...ExceptionFields
    }
  }
`;

export const RESOLVE_EXCEPTION = gql`
  ${EXCEPTION_FIELDS}
  mutation ResolveException($input: ResolveExceptionInput!) {
    resolveException(input: $input) {
      ...ExceptionFields
    }
  }
`;

export const REOPEN_EXCEPTION = gql`
  ${EXCEPTION_FIELDS}
  mutation ReopenException($input: ReopenExceptionInput!) {
    reopenException(input: $input) {
      ...ExceptionFields
    }
  }
`;

export const COMMENT_ON_EXCEPTION = gql`
  ${EXCEPTION_FIELDS}
  mutation CommentOnException($input: CommentOnExceptionInput!) {
    commentOnException(input: $input) {
      ...ExceptionFields
      comments {
        id
        body
        authorName
        createdAt
      }
    }
  }
`;

export const ANALYZE_EXCEPTION = gql`
  mutation AnalyzeException($exceptionId: ID!) {
    analyzeException(exceptionId: $exceptionId) {
      id
      status
      provider
      model
      promptVersion
      errorCode
      errorMessage
      durationMs
      analysis {
        summary
        possibleExplanations
        recommendedNextSteps
        missingInformation
        supportingRecords {
          recordType
          recordId
          label
        }
      }
      toolCalls {
        sequence
        toolName
        allowed
        denialReason
        resultSummary
      }
    }
  }
`;

// --------------------------------------------------------------------------
// Close
// --------------------------------------------------------------------------

export const CLOSE_READINESS = gql`
  ${MONEY_FIELDS}
  query CloseReadiness($propertyId: ID!, $period: Period!) {
    closeReadiness(propertyId: $propertyId, period: $period) {
      period
      periodStatus
      canClose
      evaluatedAt
      property {
        id
        code
        name
      }
      blockers {
        code
        message
        count
        resolutionHint
      }
      acknowledgements {
        code
        message
        count
        requiresReason
        amount {
          ...MoneyFields
        }
      }
      totals {
        chargesPosted {
          ...MoneyFields
        }
        paymentsReceived {
          ...MoneyFields
        }
        paymentsAllocated {
          ...MoneyFields
        }
        outstandingReceivables {
          ...MoneyFields
        }
        unappliedCash {
          ...MoneyFields
        }
      }
    }
  }
`;

export const CLOSE_SNAPSHOTS = gql`
  ${MONEY_FIELDS}
  query CloseSnapshots($propertyId: ID!) {
    closeSnapshots(propertyId: $propertyId) {
      id
      period
      closedAt
      closedBy {
        userId
        displayName
      }
      totals {
        chargesPosted {
          ...MoneyFields
        }
        outstandingReceivables {
          ...MoneyFields
        }
        unappliedCash {
          ...MoneyFields
        }
      }
      checklist {
        code
        kind
        satisfied
        message
        reason
      }
    }
  }
`;

export const START_PERIOD_REVIEW = gql`
  mutation StartPeriodReview($input: StartPeriodReviewInput!) {
    startPeriodReview(input: $input) {
      id
      period
      status
      version
    }
  }
`;

export const CLOSE_PERIOD = gql`
  mutation ClosePeriod($input: ClosePeriodInput!) {
    closePeriod(input: $input) {
      id
      period
      closedAt
      closedBy {
        displayName
      }
    }
  }
`;

export const REOPEN_PERIOD = gql`
  mutation ReopenPeriod($input: ReopenPeriodInput!) {
    reopenPeriod(input: $input) {
      id
      period
      status
      version
      reopenCount
      reopenReason
    }
  }
`;

// --------------------------------------------------------------------------
// Subledger and audit
// --------------------------------------------------------------------------

export const JOURNAL_ENTRIES = gql`
  ${MONEY_FIELDS}
  ${PAGE_INFO_FIELDS}
  query JournalEntries($filter: JournalFilter!, $first: Int, $after: String) {
    journalEntries(filter: $filter, first: $first, after: $after) {
      totalCount
      netDebitMinusCredit {
        ...MoneyFields
      }
      pageInfo {
        ...PageInfoFields
      }
      edges {
        cursor
        node {
          id
          postingEventId
          eventType
          description
          postingDate
          businessDate
          period
          sourceType
          sourceId
          reversesPostingEventId
          createdAt
          totalDebit {
            ...MoneyFields
          }
          totalCredit {
            ...MoneyFields
          }
          lines {
            id
            accountCode
            memo
            debit {
              ...MoneyFields
            }
            credit {
              ...MoneyFields
            }
          }
        }
      }
    }
  }
`;

export const ACCOUNT_BALANCES = gql`
  ${MONEY_FIELDS}
  query AccountBalances($propertyId: ID!, $period: Period!) {
    accountBalances(propertyId: $propertyId, period: $period) {
      accountCode
      balance {
        ...MoneyFields
      }
      debitTotal {
        ...MoneyFields
      }
      creditTotal {
        ...MoneyFields
      }
    }
  }
`;

export const AUDIT_EVENTS = gql`
  ${PAGE_INFO_FIELDS}
  query AuditEvents($filter: AuditFilter!, $first: Int, $after: String) {
    auditEvents(filter: $filter, first: $first, after: $after) {
      totalCount
      pageInfo {
        ...PageInfoFields
      }
      edges {
        cursor
        node {
          id
          action
          entityType
          entityId
          actorName
          actorSystem
          metadata
          correlationId
          occurredAt
          property {
            id
            code
          }
        }
      }
    }
  }
`;
