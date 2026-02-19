export interface StatementData {
  tid: number | string
  txt: string
  remaining?: number
  lang?: string
  translations?: {
    zid: number
    tid: number
    src: number
    txt: string
    lang: string
    created: string
    modified: string
  }[]
}

export interface VoteData {
  tid: number | string
  vote: number
}

export interface VoteResponse {
  nextComment?: StatementData
  [key: string]: unknown
}
