import { Resource } from 'rest-hooks'

export default class extends Resource {
  id = null
  code = ''
  name = ''
//   description = ''
//   addresses = []
//   checkout = []
//   payments = []
//   pricing = []
  pricing = []
  timeline = []
//   hostedUrl = ''
//   createdAt = ''
//   expiresAt = ''

  pk() {
    return this.id
  }

  static urlRoot = 'https://jsonplaceholder.typicode.com/omidahourai/resthooks'
}

