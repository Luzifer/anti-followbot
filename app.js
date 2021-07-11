/* global axios, moment, Highcharts, Vue */

const twitchClientID = 'kf1i6vf07ihojqei5autfb52vwl586'

Vue.config.devtools = window.localStorage?.getItem('enabled_devtools') === 'true'
new Vue({

  computed: {
    actionsDisabled() {
      return this.twitchUserID !== this.twitchAuthorizedUserID || this.blockRunStarted
    },

    affectedUsers() {
      return this.filteredFollowers.filter(f => this.protectedIDs.indexOf(f.from_id) === -1).length
    },

    authURL() {
      const scopes = [
        'user:edit:follows',
        'user:manage:blocked_users',
      ]

      const params = new URLSearchParams()
      params.set('client_id', twitchClientID)
      params.set('redirect_uri', window.location.href.split('#')[0])
      params.set('response_type', 'token')
      params.set('scope', scopes.join(' '))

      return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`
    },

    axiosOptions() {
      return {
        headers: {
          'Authorization': `Bearer ${this.twitchToken}`,
          'Client-Id': twitchClientID,
        },
      }
    },

    blockedUsers() {
      return this.filteredFollowers.filter(f => f.blocked).length
    },

    bucketSize() {
      /* eslint-disable sort-keys */
      const tickSettings = {
        604800: 600,
        86400: 120,
        3600: 60,
        1800: 30,
        900: 15,
        600: 10,
        300: 5,
        0: 1,
      }
      /* eslint-enable sort-keys */

      const timerangeSecs = Math.round((this.zoomArea.max - this.zoomArea.min) / 1000)
      for (const thresh of Object.keys(tickSettings).sort((b, a) => Number(a) - Number(b))) {
        if (timerangeSecs > Number(thresh)) {
          return tickSettings[thresh] * 1000
        }
      }

      return 60000
    },

    chartOptions() {
      return {
        chart: {
          panKey: 'shift',
          panning: {
            enabled: true,
          },

          type: 'column',
          zoomType: 'x',
        },

        legend: {
          enabled: false,
        },

        series: [
          {
            data: this.followCounts,
            name: '',
          },
        ],

        subtitle: {
          text: 'Click and drag in the plot area to zoom in / Shift + Drag to pan around',
        },

        title: {
          text: 'Follows over Time',
        },

        xAxis: {
          events: {
            afterSetExtremes: evt => this.updateZoomArea(evt),
          },

          minRange: 60 * 1000,
          tickInterval: 60 * 1000,
          type: 'datetime',
        },

        yAxis: {
          min: 0,
          title: {
            text: '',
          },
        },
      }
    },

    filteredFollowers() {
      return this.follows
        .filter(f => new Date(f.followed_at).getTime() > this.zoomArea.min && new Date(f.followed_at).getTime() < this.zoomArea.max)
        .sort((b, a) => new Date(a.followed_at).getTime() - new Date(b.followed_at).getTime())
    },

    followCounts() {
      const buckets = {}

      if (this.follows.length === 0) {
        return []
      }

      // Set current time in order to have the area better zoomable
      const nTime = new Date().getTime() + 300000
      buckets[nTime - nTime % this.bucketSize] = 0

      const sTime = new Date().getTime() - this.timespan * 86400 * 1000
      buckets[sTime - sTime % this.bucketSize] = 0

      for (const follow of this.follows) {
        const fTime = new Date(follow.followed_at).getTime()
        const bucket = fTime - fTime % this.bucketSize
        if (!buckets[bucket]) {
          buckets[bucket] = 0
        }
        buckets[bucket]++
      }

      const pcta = Object.values(buckets)
        .sort((a, b) => a - b)
      const pct = pcta[Math.round(pcta.length * 0.95)]

      return Object.keys(buckets)
        .map(t => ({
          color: buckets[t] > pct ? 'red' : '#7cb5ec',
          x: Number(t),
          y: buckets[t],
        }))
        .sort((a, b) => a.x - b.x)
    },

    protectedUsers() {
      return this.filteredFollowers.filter(f => this.protectedIDs.indexOf(f.from_id) > -1).length
    },
  },

  data() {
    return {
      blockButtonUnlocked: false,
      blockRunStarted: false,
      // bucketSize: 15000,
      chart: null,
      displayFollowers: false,
      follows: [],
      overrideUser: '',
      protectedIDs: [],
      timespan: 2,
      timespanOpts: [
        { text: '2 days', value: 2 },
        { text: '7 days', value: 7 },
        { text: '14 days', value: 14 },
        { text: '30 days', value: 30 },
      ],

      twitchAuthorizedUserID: null,
      twitchToken: null,
      twitchUserID: null,
      zoomArea: { max: 0, min: 0 },
    }
  },

  el: '#app',

  methods: {
    executeBlocks() {
      this.blockRunStarted = true

      return new Promise((resolve, reject) => {
        const fn = () => {
          const toBlock = this.filteredFollowers
            .filter(f => this.protectedIDs.indexOf(f.from_id) === -1 && !f.blocked)

          if (toBlock.length === 0) {
            console.log(`Block completed`)
            resolve()
            return
          }

          axios.put(`https://api.twitch.tv/helix/users/blocks?target_user_id=${toBlock[0].from_id}`, null, this.axiosOptions)
            .then(() => {
              Vue.set(toBlock[0], 'blocked', true)
              window.setTimeout(() => fn(), 100)
            })
            .catch(() => reject())
        }

        fn()
      })
    },

    fetchFollowers(clear = false, cursor = null) {
      this.blockButtonUnlocked = false

      const cursorQuery = cursor ? `&after=${cursor}` : ''
      axios.get(`https://api.twitch.tv/helix/users/follows?first=100&to_id=${this.twitchUserID}${cursorQuery}`, this.axiosOptions)
        .then(resp => {
          if (clear) {
            this.follows = []
            this.protectedIDs = []
          }
          this.follows = [...this.follows, ...resp.data.data]

          let oldest = new Date().getTime() // Assume now and count down
          for (const follow of this.follows) {
            oldest = Math.min(oldest, new Date(follow.followed_at).getTime())
          }
          return { cursor: resp.data.pagination.cursor, oldest }
        })
        .then(res => {
          if (new Date().getTime() - res.oldest > this.timespan * 24 * 3600 * 1000) {
            return
          }
          return this.fetchFollowers(false, res.cursor)
        })
    },

    fetchUserID(username = null, isAuth = false) {
      const userQuery = username ? `?login=${username}` : ''
      axios.get(`https://api.twitch.tv/helix/users${userQuery}`, this.axiosOptions)
        .then(resp => {
          if (!resp.data?.data || resp.data.data.length < 1) {
            throw new Error('no user profiles found')
          }

          this.twitchUserID = resp.data.data[0].id
          this.overrideUser = resp.data.data[0].login
          if (isAuth) {
            this.twitchAuthorizedUserID = resp.data.data[0].id
          }
        })
    },

    initChart() {
      return new Promise(resolve => {
        const fn = () => {
          if (document.querySelector('#chart')) {
            this.chart = Highcharts.chart('chart', this.chartOptions)
            resolve()
          } else {
            window.setTimeout(() => fn(), 100)
          }
        }

        fn()
      })
    },

    moment,

    toggleProtect(id) {
      if (this.protectedIDs.indexOf(id) > -1) {
        this.protectedIDs = this.protectedIDs.filter(pid => pid !== id)
        return
      }
      this.protectedIDs = [...this.protectedIDs, id]
    },

    updateZoomArea(evt) {
      this.zoomArea = { max: evt.max || evt.dataMax, min: evt.min || evt.dataMin }
    },
  },

  mounted() {
    this.twitchToken = new URLSearchParams(window.location.hash.substr(1)).get('access_token') || null
    if (this.twitchToken) {
      window.location.hash = '' // Remove token from hash for security
      this.initChart()
    }
  },

  name: 'AntiFollowBot',

  watch: {
    chartOptions(to) {
      this.chart.update(to)
    },

    timespan(to, from) {
      if (to === from) {
        return
      }
      this.fetchFollowers(true, null)
    },

    twitchToken() {
      this.fetchUserID(null, true)
    },

    twitchUserID() {
      this.fetchFollowers(true, null)
    },
  },

})
