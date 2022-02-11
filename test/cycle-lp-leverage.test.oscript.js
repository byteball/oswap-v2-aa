// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai')
const { promisify } = require('util')
const path = require('path')
const fs = require('fs')
const objectHash = require("ocore/object_hash.js");
const parseOjson = require('ocore/formula/parse_ojson').parse;

async function getAaAddress(aa_src) {
	return objectHash.getChash160(await promisify(parseOjson)(aa_src));
}

function round(n, precision) {
	return parseFloat(n.toPrecision(precision));
}


describe('Cyclic trades in the pool', function () {
	this.timeout(120000)

	before(async () => {

		const pool_lib = fs.readFileSync(path.join(__dirname, '../pool-lib.oscript'), 'utf8');
		const pool_lib_address = await getAaAddress(pool_lib);
		const pool_lib_by_price = fs.readFileSync(path.join(__dirname, '../pool-lib-by-price.oscript'), 'utf8');
		const pool_lib_by_price_address = await getAaAddress(pool_lib_by_price);
		let pool_base = fs.readFileSync(path.join(__dirname, '../pool.oscript'), 'utf8');
		pool_base = pool_base.replace(/\$pool_lib_aa = '\w{32}'/, `$pool_lib_aa = '${pool_lib_address}'`)
		pool_base = pool_base.replace(/\$pool_lib_by_price_aa = '\w{32}'/, `$pool_lib_by_price_aa = '${pool_lib_by_price_address}'`)
		const pool_base_address = await getAaAddress(pool_base);
		let factory = fs.readFileSync(path.join(__dirname, '../factory.oscript'), 'utf8');
		factory = factory.replace(/\$pool_base_aa = '\w{32}'/, `$pool_base_aa = '${pool_base_address}'`)

		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.asset({ ousd: {} })
			.with.asset({ obit: {} })
			.with.agent({ lbc: path.join(__dirname, '../linear-bonding-curve.oscript') })
			.with.agent({ pool_lib: path.join(__dirname, '../pool-lib.oscript') })
			.with.agent({ pool_lib_by_price: path.join(__dirname, '../pool-lib-by-price.oscript') })
			.with.agent({ pool_base })
			.with.agent({ governance_base: path.join(__dirname, '../governance.oscript') })
			.with.agent({ factory })
			.with.wallet({ alice: {base: 100e9, obit: 100e9, ousd: 10000e9} })
			.with.wallet({ bob: {base: 100e9, obit: 100e9, ousd: 10000e9} })
		//	.with.explorer()
			.run()
		
		console.log('--- agents\n', this.network.agent)
		this.ousd = this.network.asset.ousd
		this.obit = this.network.asset.obit
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()

		this.executeGetter = async (getter, args = []) => {
			const { result, error } = await this.alice.executeGetter({
				aaAddress: this.pool_aa,
				getter,
				args
			})
			expect(error).to.be.null
			return result
		}

		this.timetravel = async (shift = '1d') => {
			const { error, timestamp } = await this.network.timetravel({ shift })
			expect(error).to.be.null
	
			const { balances, leveraged_balances, ts } = await this.executeGetter('get_balances_after_interest')
			this.balances = balances
			this.leveraged_balances = leveraged_balances
		}

		this.get_price = async (asset_label, bAfterInterest = true) => {
			return await this.executeGetter('get_price', [asset_label, 0, 0, bAfterInterest])
		}

		this.get_leveraged_price = async (asset_label, L) => {
			return await this.executeGetter('get_leveraged_price', [asset_label, L, true])
		}

		this.checkTotals = async (bAfterInterest) => {
			const totals = bAfterInterest
				? await this.executeGetter('get_total_balances', [true])
				: await this.executeGetter('get_total_balances')
		//	console.log('totals', totals)
			expect(totals.x.excess).to.be.closeTo(0, 0.1)
			expect(totals.y.excess).to.be.closeTo(0, 0.1)
		}

		this.checkBalancesLeverage = (balances, both) => {
			if (!balances)
				balances = this.balances
			if (this.pool_leverage === 1) {
				expect(balances.x).to.be.eq(balances.xn)
				expect(balances.y).to.be.eq(balances.yn)
			}
			else {
				const x_leverage = balances.x / balances.xn
				const y_leverage = balances.y / balances.yn
				const x_ratio = round(x_leverage / this.pool_leverage, 13)
				const y_ratio = round(y_leverage / this.pool_leverage, 13)
			//	console.log({x_ratio, y_ratio, x_leverage, y_leverage})
				const along_x = x_ratio === 1 && y_ratio <= 1
				const along_y = y_ratio === 1 && x_ratio <= 1
				if (both)
					expect(along_x && along_y).to.be.true
				else
					expect(along_x || along_y).to.be.true
			}
		}
	})

	it('Bob defines a new pool', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null
		
	//	this.x_asset = 'base'
		this.x_asset = this.obit
		this.y_asset = this.ousd
		this.base_interest_rate = 0//.3
		this.swap_fee = 0//.003
		this.exit_fee = 0//.05
		this.leverage_profit_tax = 0//.1
		this.arb_profit_tax = 0.9
		this.alpha = 0.5
		this.beta = 1 - this.alpha
	//	this.mid_price = 100
	//	this.price_deviation = 1.3
		this.pool_leverage = 10
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.factory,
			amount: 10000,
			data: {
				x_asset: this.x_asset,
				y_asset: this.y_asset,
				swap_fee: this.swap_fee,
				exit_fee: this.exit_fee,
				leverage_profit_tax: this.leverage_profit_tax,
				arb_profit_tax: this.arb_profit_tax,
				base_interest_rate: this.base_interest_rate,
				alpha: this.alpha,
				mid_price: this.mid_price,
				price_deviation: this.price_deviation,
				pool_leverage: this.pool_leverage,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.pool_aa = response.response.responseVars.address
		expect(this.pool_aa).to.be.validAddress

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		this.governance_aa = vars.governance_aa
		this.shares_asset = vars.lp_shares.asset
		expect(this.shares_asset).to.be.validUnit

		this.linear_shares = 0
		this.issued_shares = 0
		this.coef = 1
		this.balances = { x: 0, y: 0, xn: 0, yn: 0 }
		this.profits = { x: 0, y: 0 }
		this.leveraged_balances = {}

		this.bounce_fees = this.x_asset !== 'base' && { base: [{ address: this.pool_aa, amount: 1e4 }] }
		this.bounce_fee_on_top = this.x_asset === 'base' ? 1e4 : 0

	})


	it('Alice adds liquidity', async () => {
		const x_amount = 1e9
		const y_amount = 100e9
		this.price = y_amount / x_amount
		const new_linear_shares = this.mid_price
			? Math.round(x_amount * this.mid_price ** this.beta * this.price_deviation / (this.price_deviation - 1))
			: Math.round(x_amount ** this.alpha * y_amount ** this.beta)
		this.balances.x += x_amount * this.pool_leverage
		this.balances.y += y_amount * this.pool_leverage
		this.balances.xn += x_amount
		this.balances.yn += y_amount
		const new_issued_shares = new_linear_shares
		this.linear_shares += new_linear_shares
		this.issued_shares += new_issued_shares
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{ address: this.pool_aa, amount: x_amount + this.bounce_fee_on_top }],
				[this.y_asset]: [{ address: this.pool_aa, amount: y_amount }],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy_shares: 1,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.shares_asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])

		this.recent = {
			last_ts: response.timestamp,
		}

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.eq(this.coef)
		expect(vars.balances).to.be.deep.eq(this.balances)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deep.eq(this.profits)
		expect(vars.recent).to.be.deep.eq(this.recent)

		const pool_value = this.balances.yn + this.price * this.balances.xn
		const share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})

	it('Bob swaps', async () => {
		// get the initial price
		const initial_price = await this.get_price('x')
		console.log({ initial_price })

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const y_change = 1e9
		const final_price = initial_price * (this.mid_price ? 1.1 : 1.2)
		const result = await this.executeGetter('get_swap_amounts_by_final_price', ['y', final_price])
		console.log('swap result', result)
		const { in: y_amount, out: net_x_amount, arb_profit_tax, fees, balances } = result
		this.checkBalancesLeverage(balances)
		const x_amount = net_x_amount + fees.out
		const y_amount_sans_rounding_fee = y_amount - fees.in
		const avg_price = y_amount / x_amount
		expect(avg_price).to.be.gt(initial_price)
		expect(avg_price).to.be.lt(final_price)
		this.initial_y_investment = y_amount

		if (this.pool_leverage === 1) {
			// simple calculation
			const expected_x_amount = (this.balances.x + x0) * (1 - (1 + y_amount_sans_rounding_fee / (this.balances.y + y0)) ** (-this.beta / this.alpha))
		//	const expected_x_amount = Math.floor(this.balances.x * y_amount / (this.balances.y + y_amount))
			expect(expected_x_amount).to.be.closeTo(x_amount, 0.1)

			this.balances.x -= x_amount
			this.balances.y += y_amount_sans_rounding_fee
			this.balances.xn -= x_amount
			this.balances.yn += y_amount_sans_rounding_fee
			this.profits.x += fees.out
			this.profits.y += fees.in
		}
		else {
			expect(balances.x / this.pool_leverage).to.closeTo(balances.xn, 0.001)
			this.balances.x = balances.x
			this.balances.y -= y_amount_sans_rounding_fee * (this.beta * this.pool_leverage - 1) / this.alpha
			this.balances.xn -= net_x_amount
			this.balances.yn += y_amount

			// add the fee
			const added_y = fees.out / (this.balances.xn - fees.out) * this.balances.y
		//	console.log('initial balances.y', this.balances.y, 'added', added_y, 'Xn', this.balances.xn - fees.out)
			this.balances.y += fees.out / (this.balances.xn - fees.out) * this.balances.y
		//	console.log('this.balances', this.balances, 'balances after swap', balances)
			expect(this.balances.y).to.be.closeTo(balances.y, this.pool_leverage * final_price) // ceil x
			this.balances.y = balances.y
		}
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.y_asset]: [{address: this.pool_aa, amount: y_amount + y_change}],
			},
			messages: [{
				app: 'data',
				payload: {
					final_price: final_price,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('swap logs', JSON.stringify(response.logs, null, 2))

		this.recent.prev = false
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: 100,
			pmax: final_price,
		}
		this.recent.last_trade = {
			address: this.bobAddress,
			pmin: 100,
			pmax: final_price,
			amounts: { x: x_amount, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.y_asset,
				address: this.bobAddress,
				amount: y_change,
			},
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: net_x_amount,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 12)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		this.balances = vars.balances

		// check the final price
		const price = await this.get_price('x')
		expect(price).to.be.equalWithPrecision(final_price, 9)
		this.price = price

		this.result = { x: net_x_amount, y: -y_amount }
		console.log('bob result', this.result)

		const pool_value = this.balances.yn + this.price * this.balances.xn
		const share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})

	it('Bob swaps again', async () => {
		await this.timetravel()

		// get the initial price
		const initial_price = await this.get_price('x')
		console.log({ initial_price })

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const y_change = 1e9
		const final_price = initial_price * (this.mid_price ? 1.1 : 1.2)
		const result = await this.executeGetter('get_swap_amounts_by_final_price', ['y', final_price])
		console.log('swap result', result)
		const { in: y_amount, out: net_x_amount, arb_profit_tax, fees, balances } = result
		this.checkBalancesLeverage(balances)
		const x_amount = net_x_amount + fees.out
		const y_amount_sans_rounding_fee = y_amount - fees.in
		const avg_price = y_amount / x_amount
		expect(avg_price).to.be.gt(initial_price)
		expect(avg_price).to.be.lt(final_price)
		this.initial_y_investment = y_amount

		if (this.pool_leverage === 1) {
			// simple calculation
			const expected_x_amount = (this.balances.x + x0) * (1 - (1 + y_amount_sans_rounding_fee / (this.balances.y + y0)) ** (-this.beta / this.alpha))
		//	const expected_x_amount = Math.floor(this.balances.x * y_amount / (this.balances.y + y_amount))
			expect(expected_x_amount).to.be.closeTo(x_amount, 0.1)

			this.balances.x -= x_amount
			this.balances.y += y_amount_sans_rounding_fee
			this.balances.xn -= x_amount
			this.balances.yn += y_amount_sans_rounding_fee
			this.profits.x += fees.out
			this.profits.y += fees.in
		}
		else {
			expect(balances.x / this.pool_leverage).to.closeTo(balances.xn, 0.001)
			this.balances.x = balances.x
			this.balances.y -= y_amount_sans_rounding_fee * (this.beta * this.pool_leverage - 1) / this.alpha
			this.balances.xn -= net_x_amount
			this.balances.yn += y_amount

			// add the fee
			const added_y = fees.out / (this.balances.xn - fees.out) * this.balances.y
		//	console.log('initial balances.y', this.balances.y, 'added', added_y, 'Xn', this.balances.xn - fees.out)
			this.balances.y += fees.out / (this.balances.xn - fees.out) * this.balances.y
		//	console.log('this.balances', this.balances, 'balances after swap', balances)
			expect(this.balances.y).to.be.closeTo(balances.y, this.pool_leverage * final_price) // ceil x
			this.balances.y = balances.y
		}
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.y_asset]: [{address: this.pool_aa, amount: y_amount + y_change}],
			},
			messages: [{
				app: 'data',
				payload: {
					final_price: final_price,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('swap logs', JSON.stringify(response.logs, null, 2))

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: initial_price,
			pmax: final_price,
		}
		this.recent.last_trade = {
			address: this.bobAddress,
			pmin: initial_price,
			pmax: final_price,
			amounts: { x: x_amount, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.y_asset,
				address: this.bobAddress,
				amount: y_change,
			},
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: net_x_amount,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 12)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.01)

		this.balances = vars.balances

		// check the final price
		const price = await this.get_price('x')
		expect(price).to.be.equalWithPrecision(final_price, 9)
		this.price = price

		this.result.x += net_x_amount
		this.result.y -= y_amount
		console.log('bob result', this.result)

		const pool_value = this.balances.yn + this.price * this.balances.xn
		const share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Bob adds more liquidity and the profits get added to the pool', async () => {
	//	process.exit()
	//	await this.timetravel()
		const initial_price = await this.get_price('x')

		const x_change = 0
		const y_change = 0
		const y2x = this.balances.y / this.balances.x
		const x_amount_to_full_leverage = Math.floor(this.balances.yn / y2x - this.balances.xn)
		const available_x_amount = this.result.x
		console.log({ available_x_amount, x_amount_to_full_leverage })
		const x_amount = Math.min(available_x_amount, x_amount_to_full_leverage)
	//	expect(x_amount).to.be.lt(this.result.x)

		let share_price_in_y = (this.balances.yn + this.balances.xn * this.price) / this.linear_shares
		let share_price_in_x = (this.balances.yn / 100 + this.balances.xn) / this.linear_shares
	//	const share_price_in_x = share_price_in_y / this.price
		const new_linear_shares = Math.floor(x_amount / share_price_in_x)
		const new_issued_shares = new_linear_shares

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: x_amount + x_change + this.bounce_fee_on_top}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy_shares: 1,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('logs', JSON.stringify(response.logs, null, 2))

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.shares_asset,
				address: this.bobAddress,
				amount: new_issued_shares,
			},
		])

		this.balances.x += x_amount * this.pool_leverage
		this.balances.y += y2x * x_amount * this.pool_leverage
		this.balances.xn += x_amount
		this.balances.yn += 0
		this.linear_shares += new_linear_shares
		this.issued_shares += new_issued_shares

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 11)
		expect(vars.balances).to.be.deepCloseTo(this.balances, .022)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deep.eq(this.profits)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.01)

		this.balances = vars.balances
		this.profits = vars.profits
		this.linear_shares = vars.lp_shares.linear
		this.issued_shares = vars.lp_shares.issued

		const final_price = await this.get_price('x')
		console.log({ final_price, diff: final_price / initial_price - 1, balances: this.balances })
		expect(final_price).to.be.equalWithPrecision(initial_price, 5)

		this.result.x -= x_amount
		this.result.shares = new_issued_shares
		console.log('bob result', this.result)

		const pool_value = this.balances.yn + this.price * this.balances.xn
		share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Bob removes liquidity', async () => {
		const redeemed_linear_shares = this.result.shares
		const redeemed_issued_shares = redeemed_linear_shares
		const x_amount_exact = redeemed_linear_shares / this.linear_shares * this.balances.xn * (1 - this.exit_fee)
		const y_amount_exact = redeemed_linear_shares / this.linear_shares * this.balances.yn * (1 - this.exit_fee)
		const x_amount = Math.floor(x_amount_exact)
		const y_amount = Math.floor(y_amount_exact)
		
		this.balances.x -= redeemed_linear_shares / this.linear_shares * this.balances.x * (1 - this.exit_fee)
		this.balances.y -= redeemed_linear_shares / this.linear_shares * this.balances.y * (1 - this.exit_fee)
		this.balances.xn -= x_amount_exact
		this.balances.yn -= y_amount_exact
		this.linear_shares -= redeemed_linear_shares
		this.issued_shares -= redeemed_issued_shares

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.shares_asset]: [{address: this.pool_aa, amount: redeemed_issued_shares}],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: x_amount,
			},
			{
				asset: this.y_asset,
				address: this.bobAddress,
				amount: y_amount,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 12)
		expect(vars.balances).to.be.deepCloseTo(this.balances, this.pool_leverage * this.price)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.01)

		this.balances = vars.balances

		this.result.x += x_amount
		this.result.y += y_amount
		this.result.shares -= redeemed_linear_shares
		console.log('bob result', this.result)

		const pool_value = this.balances.yn + this.price * this.balances.xn
		const share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Bob swaps the remaining x to y by delta x', async () => {
		const initial_price = await this.get_price('x')
		console.log({ initial_price })

		const { profits, balances: initial_balances, leveraged_balances: initial_leveraged_balances } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits
	//	console.log('balances after interest', { initial_balances, initial_leveraged_balances })
		expect(initial_balances).to.be.deep.eq(this.balances)

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const x_change = 0
		const delta_xn = this.result.x
		const result = await this.executeGetter('get_swap_amounts_by_delta_net_balance', ['x', delta_xn, 0, 0, this.bobAddress])
		console.log('swap result', result)
		const { in: x_amount, out: net_y_amount, arb_profit_tax, fees, balances, leveraged_balances, final_price: final_y_price } = result
		expect(x_amount).to.be.eq(delta_xn)
		this.checkBalancesLeverage(balances)
		if (this.pool_leverage === 1)
			expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_xn, 12)
		else
			expect(balances.xn).to.be.within(this.balances.xn + delta_xn, this.balances.xn + delta_xn + fees.in)
		expect(result.initial_price).to.be.equalWithPrecision(1/initial_price, 13)
		const y_amount = net_y_amount + fees.out
		const avg_price = x_amount / y_amount
		expect(avg_price).to.be.gt(1 / initial_price)
		expect(avg_price).to.be.lt(final_y_price)

		this.balances = balances
		this.leveraged_balances = leveraged_balances

		this.recent.last_trade.amounts.y = y_amount
		this.recent.last_trade.paid_taxes.y = arb_profit_tax

		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: x_amount + x_change}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					delta_xn: delta_xn,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: x_change,
			},
			{
				asset: this.y_asset,
				address: this.bobAddress,
				amount: net_y_amount,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, this.pool_leverage * this.price)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.01)

		// check the final price
		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after swap', final_price / initial_price)
		expect(final_price).to.be.equalWithPrecision(1/final_y_price, 9)
		this.price = final_price

		this.result.x -= x_amount
		this.result.y += net_y_amount
		console.log('bob result', this.result, 'profit', this.result.y / this.initial_y_investment)
		console.log('bob balance', await this.bob.getBalance())

		const pool_value = this.balances.yn + this.price * this.balances.xn
		const share_price_in_y = pool_value / this.linear_shares
		console.log('pool value in y', pool_value / 1e9, { share_price_in_y })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})



	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
