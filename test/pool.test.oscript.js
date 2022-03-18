// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai')
const { promisify } = require('util')
const path = require('path')
const fs = require('fs')
const objectHash = require("ocore/object_hash.js");
const parseOjson = require('ocore/formula/parse_ojson').parse

async function getAaAddress(aa_src) {
	return objectHash.getChash160(await promisify(parseOjson)(aa_src));
}

function round(n, precision) {
	return parseFloat(n.toPrecision(precision));
}


describe('Various trades in the pool', function () {
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
			.with.agent({ qbc: path.join(__dirname, '../quadratic-bonding-curve.oscript') })
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
		console.log('--- assets\n', this.network.asset)
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

		this.canceled_profits = { x: 0, y: 0 }

		this.checkTotals = async (bAfterInterest) => {
			const totals = bAfterInterest
				? await this.executeGetter('get_total_balances', [true])
				: await this.executeGetter('get_total_balances')
			console.log('totals', totals)
			expect(totals.x.excess - this.canceled_profits.x).to.be.closeTo(0, 0.1)
			expect(totals.y.excess - this.canceled_profits.y).to.be.closeTo(0, 0.1)
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
		this.base_interest_rate = 0.3
		this.swap_fee = 0.003
		this.exit_fee = 0.005
		this.leverage_profit_tax = 0.1
		this.arb_profit_tax = 0.99
		this.alpha = 0.5
		this.beta = 1 - this.alpha
	//	this.mid_price = 100
	//	this.price_deviation = 1.3
		this.pool_leverage = 10
	//	this.quadratic = true
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
				...(this.quadratic && { shares_bonding_curve: this.network.agent.qbc }),
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

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

	it('Alice adds a positive leverage pool', async () => {
		const L = 5
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.pool_aa,
			amount: 10000,
			data: {
				define_leverage: 1,
				leverage: L,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['leveraged_asset' + L]).to.be.eq(response.response_unit)
		this['leveraged_asset' + L] = response.response_unit
		
		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars['leveraged_asset' + L]).to.be.eq(response.response_unit)
	})

	it('Alice adds a negative leverage pool', async () => {
		const L = -10
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.pool_aa,
			amount: 10000,
			data: {
				define_leverage: 1,
				leverage: L,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['leveraged_asset' + L]).to.be.eq(response.response_unit)
		this['leveraged_asset' + L] = response.response_unit
		
		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars['leveraged_asset' + L]).to.be.eq(response.response_unit)
	})

	it('Alice adds liquidity', async () => {
		const x_amount = 1e9
		const y_amount = 100e9
		this.initial_price = this.alpha / this.beta * y_amount / x_amount
		const new_linear_shares = this.mid_price
			? Math.round(x_amount * this.mid_price ** this.beta * this.price_deviation / (this.price_deviation - 1))
			: Math.round(x_amount ** this.alpha * y_amount ** this.beta)
		this.balances.x += x_amount * this.pool_leverage
		this.balances.y += y_amount * this.pool_leverage
		this.balances.xn += x_amount
		this.balances.yn += y_amount
		const new_issued_shares = this.quadratic ? Math.floor(Math.sqrt(new_linear_shares)) : new_linear_shares
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

		this.checkBalancesLeverage()
		await this.checkTotals()
	})

	it('Alice adds more liquidity', async () => {
		const x_change = 0.02e9
		const y_change = 0//3e9
		const x_amount = 0.1e9 
		const y_amount = 10e9
		const new_linear_shares_exact = (this.linear_shares * x_amount / this.balances.xn)
		const new_linear_shares = Math.floor(new_linear_shares_exact)
		const coef = (this.linear_shares + new_linear_shares_exact) / (this.linear_shares + new_linear_shares)
		this.balances.x += x_amount * this.pool_leverage
		this.balances.y += y_amount * this.pool_leverage
		this.balances.xn += x_amount
		this.balances.yn += y_amount
		this.linear_shares += new_linear_shares
		const new_issued_shares = this.quadratic ? Math.floor(Math.sqrt(this.linear_shares)) - this.issued_shares : new_linear_shares
		this.issued_shares += new_issued_shares
		if (this.pool_leverage === 1)
			this.coef *= coef
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: x_amount + x_change + this.bounce_fee_on_top}],
				[this.y_asset]: [{address: this.pool_aa, amount: y_amount + y_change}],
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
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.shares_asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: x_change,
			},
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: y_change,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 12)
		expect(vars.balances).to.be.deep.eq(this.balances)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deep.eq(this.profits)
		expect(vars.recent).to.be.deep.eq(this.recent)

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Alice removes liquidity', async () => {
	//	console.log('balances before', this.balances)
		const gross_x_amount = 0.1e9 
		const gross_y_amount = 10e9
	//	const x_amount = Math.floor(gross_x_amount * (1 - this.exit_fee))
	//	const y_amount = Math.floor(gross_y_amount * (1 - this.exit_fee))
		let redeemed_linear_shares = Math.round(gross_x_amount / this.balances.xn * this.linear_shares)
		const redeemed_issued_shares = this.quadratic
			? this.issued_shares - Math.round(Math.sqrt(this.linear_shares - redeemed_linear_shares))
			: redeemed_linear_shares
		if (this.quadratic)
			redeemed_linear_shares = this.linear_shares - (this.issued_shares - redeemed_issued_shares) ** 2
		const x_amount_exact = redeemed_linear_shares / this.linear_shares * this.balances.xn * (1 - this.exit_fee)
		const y_amount_exact = redeemed_linear_shares / this.linear_shares * this.balances.yn * (1 - this.exit_fee)
		const x_amount = Math.floor(x_amount_exact)
		const y_amount = Math.floor(y_amount_exact)
		
		this.balances.x -= (this.pool_leverage === 1 ? x_amount_exact : x_amount) * this.pool_leverage
		this.balances.y -= (this.pool_leverage === 1 ? y_amount_exact : y_amount) * this.pool_leverage
		this.balances.xn -= this.pool_leverage === 1 ? x_amount_exact : x_amount
		this.balances.yn -= this.pool_leverage === 1 ? y_amount_exact : y_amount
		if (this.pool_leverage == 1) {
			this.profits.x += x_amount_exact - x_amount
			this.profits.y += y_amount_exact - y_amount
			this.coef *= (this.linear_shares - redeemed_linear_shares * (1 - this.exit_fee)) / (this.linear_shares - redeemed_linear_shares)
		}
		this.linear_shares -= redeemed_linear_shares
		this.issued_shares -= redeemed_issued_shares

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.shares_asset]: [{address: this.pool_aa, amount: redeemed_issued_shares}],
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: x_amount,
			},
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: y_amount,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 12)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 2 * this.pool_leverage)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deep.eq(this.recent)

		this.balances = vars.balances
		this.profits = vars.profits

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Alice swaps', async () => {
		// get the initial price
		const initial_price = await this.get_price('x')
		console.log({ initial_price })

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const y_change = 1e9
		const final_price = initial_price * (this.mid_price ? 1.05 : 1.1)
		const result = await this.executeGetter('get_swap_amounts_by_final_price', ['y', final_price])
		console.log('result', result)
		const { in: y_amount, out: net_x_amount, arb_profit_tax, fees, balances } = result
		this.checkBalancesLeverage(balances)
		const x_amount = net_x_amount + fees.out
		const y_amount_sans_rounding_fee = y_amount - fees.in
		const avg_price = y_amount / x_amount
		expect(avg_price).to.be.gt(initial_price)
		expect(avg_price).to.be.lt(final_price)

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
			console.log('initial balances.y', this.balances.y, 'added', added_y, 'Xn', this.balances.xn - fees.out)
			this.balances.y += fees.out / (this.balances.xn - fees.out) * this.balances.y
			console.log('this.balances', this.balances, 'balances after swap', balances)
			expect(this.balances.y).to.be.closeTo(balances.y, this.pool_leverage * final_price) // ceil x
			this.balances.y = balances.y
		}

		const { unit, error } = await this.alice.sendMulti({
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

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('swap logs', JSON.stringify(response.logs, null, 2))

		this.recent.prev = false
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: this.initial_price,
			pmax: final_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: this.initial_price,
			pmax: final_price,
			amounts: { x: x_amount, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: y_change,
			},
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: net_x_amount,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 12)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.000001)

		this.balances = vars.balances
		this.profits = vars.profits

		// check the final price
		const price = await this.get_price('x')
		expect(price).to.be.equalWithPrecision(final_price, 9)
		this.price = price

		this.checkBalancesLeverage()
		await this.checkTotals()
	})

	it('Alice swaps again after 3 days, this time by delta y', async () => {
		await this.timetravel()

		// get the initial price
		const initial_price = await this.get_price('x')
		console.log({ initial_price })

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		console.log({profits})
		expect(profits).to.be.deep.eq(this.profits)

		const y_change = 1e9

		const delta_yn = this.pool_leverage === 1 ? 12e9 : 25e9 + 0.5
		const result = await this.executeGetter('get_swap_amounts_by_delta_net_balance', ['y', delta_yn])
		console.log('result', result)
		const { in: y_amount, out: net_x_amount, arb_profit_tax, fees, balances, final_price } = result
		this.checkBalancesLeverage(balances)
		const x_amount = net_x_amount + fees.out
		const y_amount_sans_rounding_fee = y_amount - fees.in
		const avg_price = y_amount / x_amount
		expect(avg_price).to.be.gt(initial_price)
		expect(avg_price).to.be.lt(final_price)

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
			console.log('initial balances.y', this.balances.y, 'added', added_y, 'Xn', this.balances.xn - fees.out)
			this.balances.y += fees.out / (this.balances.xn - fees.out) * this.balances.y
			console.log('this.balances', this.balances, 'balances after swap', balances)
			expect(this.balances.y).to.be.closeTo(balances.y, this.pool_leverage * final_price) // ceil x
			this.balances.y = balances.y
		}

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.y_asset]: [{address: this.pool_aa, amount: y_amount + y_change}],
			},
			messages: [{
				app: 'data',
				payload: {
					delta_yn: delta_yn,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('swap logs', JSON.stringify(response.logs, null, 2))
	//	await this.network.witnessUntilStable(response.response_unit)

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: initial_price,
			pmax: final_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: initial_price,
			pmax: final_price,
			amounts: { x: x_amount, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: y_change,
			},
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: net_x_amount,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 12)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.000001)

		this.balances = vars.balances
		this.profits = vars.profits

		// check the final price
		const price = await this.get_price('x')
		expect(price).to.be.equalWithPrecision(final_price, 9)
		this.price = price

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Alice adds more liquidity and the profits get added to the pool', async () => {
	//	process.exit()
		const initial_price = await this.get_price('x')

	//	console.log('profits', this.profits)
		const x_change = 0
		const y_change = 0
		const x_amount = 2e9
		let y_amount_exact = x_amount * this.balances.y / this.balances.x
		let y_amount = Math.round(y_amount_exact)
		console.log({x_amount, y_amount})

	//	const share_price_in_y = (this.balances.y + (this.balances.x + this.profits.x) * this.price) / this.linear_shares
	//	const proportional_shares = (x_amount - this.profits.x) / this.balances.x * this.linear_shares
	//	const shares_for_y = this.profits.x * this.price / share_price_in_y
	//	const new_shares = Math.round(proportional_shares + shares_for_y)
	//	console.log({ proportional_shares, shares_for_y, new_shares })
		
		if (this.pool_leverage === 1) {
			const share_price_in_y = (this.balances.yn + this.balances.xn * this.price) / this.linear_shares
			const share_price_in_x = share_price_in_y / this.price
			var excess_y = 0
			const proportional_shares = (x_amount / this.balances.xn * this.linear_shares)
			const pools_shares_for_x = (this.profits.x / share_price_in_x)
			var new_linear_shares = Math.floor(proportional_shares - pools_shares_for_x)
			var coef = (this.linear_shares + proportional_shares) / (this.linear_shares + new_linear_shares)
			console.log({ proportional_shares, pools_shares_for_x, new_linear_shares, coef })
		}
		else {
			// using min price 100
			const share_price_in_x = (this.balances.yn / this.initial_price + this.balances.xn) / this.linear_shares
			const target_yn = (this.balances.y / this.pool_leverage)
			const delta_xn1 = (this.balances.yn / target_yn - 1) * this.balances.xn
			expect(delta_xn1).to.be.lte(x_amount)

			// to avoid rounding errors, recalc y_amount based on the ratio of net balances, like oscript does
			y_amount_exact = (x_amount * this.balances.yn / (this.balances.xn + delta_xn1))
			y_amount = Math.round(y_amount_exact)
			console.log({ x_amount, y_amount })
			
			var excess_y = Math.floor(delta_xn1 * this.balances.yn / (this.balances.xn + delta_xn1))
		//	var excess_y = Math.round(delta_xn1 * this.balances.y / this.balances.x)
			const shares1 = delta_xn1 / share_price_in_x
			const proportional_shares = (x_amount - delta_xn1) / (this.balances.xn + delta_xn1) * (this.linear_shares + shares1)
			var new_linear_shares = Math.floor(proportional_shares + shares1)
			var coef = 1
			console.log({ proportional_shares, shares1, new_linear_shares, delta_xn1, target_yn, excess_y })
		}
		const new_issued_shares = this.quadratic
			? Math.floor(Math.sqrt(this.linear_shares + new_linear_shares)) - this.issued_shares
			: new_linear_shares

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: x_amount + x_change + this.bounce_fee_on_top}],
				[this.y_asset]: [{address: this.pool_aa, amount: y_amount + y_change}],
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
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
	//	await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.shares_asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: Math.floor(this.profits.x),
			},
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: y_change + excess_y,
			},
		], 1)

		this.balances.x += x_amount * this.pool_leverage
		this.balances.y += y_amount_exact * this.pool_leverage
		this.balances.xn += x_amount
		this.balances.yn += y_amount_exact - excess_y
		if (this.pool_leverage === 1)
			this.profits = { x: 0, y: 0 }
		this.linear_shares += new_linear_shares
		this.issued_shares += new_issued_shares
		this.coef *= coef

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.closeTo(this.issued_shares, 1)
		expect(vars.lp_shares.linear).to.be.closeTo(this.linear_shares, 1)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 10)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 3)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 1)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)

		this.balances = vars.balances
		this.profits = vars.profits
		this.linear_shares = vars.lp_shares.linear
		this.issued_shares = vars.lp_shares.issued

		const final_price = await this.get_price('x')
		console.log({ final_price, diff: final_price / initial_price - 1 })
		expect(final_price).to.be.equalWithPrecision(initial_price, 5)

		this.checkBalancesLeverage()
		await this.checkTotals()
	})



	it('Alice buys L-tokens', async () => {
	//	return;
		const x_change = 0.01e9
		const delta_Xn = -0.1e9
		const L = 5
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['x', L, delta_Xn, 0, this.aliceAddress])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, initial_price, final_price } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		expect(balances.x).to.be.equalWithPrecision((this.balances.xn + delta_Xn + added_fee) * this.pool_leverage, 12)
		expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(shares)
		expect(avg_share_price).to.be.equalWithPrecision(1, 6)
		
		this.balances.x = balances.x
		this.balances.y = balances.y
		this.balances.xn += delta_Xn + added_fee
		this.balances.yn = balances.yn
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.x += total_fee

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: gross_delta + x_change}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
					tokens: 1,
					L: L,
					asset: 'x',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.recent.current.pmax = final_price
		this.recent.last_ts = response.timestamp

		// the trades are merged
		this.recent.last_trade.pmax = final_price
		this.recent.last_trade.amounts.x += net_delta
		this.recent.last_trade.paid_taxes.x += arb_profit_tax

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this['leveraged_asset' + L],
				address: this.aliceAddress,
				amount: shares,
			},
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: x_change,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.0001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ final_x5_leveraged_price })
		expect(final_x5_leveraged_price).to.be.gt(1)
		expect(final_x5_leveraged_price).to.be.gt(avg_share_price)

		this.checkBalancesLeverage()
		await this.checkTotals()

		const utilization_ratio = await this.executeGetter('get_utilization_ratio')
		console.log({ utilization_ratio })

		await this.timetravel()
		await this.checkTotals(true)
	})



	it('Alice buys more L-tokens', async () => {
	//	process.exit()
	//	return;
		await this.timetravel()

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ initial_price, initial_x5_leveraged_price })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits

		const x_change = 1e4
		const delta_Xn = -0.001e9
		const L = 5
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['x', L, delta_Xn])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, final_price: l_final_price } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		expect(balances.x).to.be.equalWithPrecision(this.balances.x + (delta_Xn + added_fee) * this.pool_leverage, 12)
		expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(this.leveraged_balances[L + 'x'].supply + shares)
		expect(avg_share_price).to.be.gt(initial_x5_leveraged_price)
	//	expect(avg_share_price).to.be.gt(1) // might be less than 1 due to interest
		
		this.balances.x += (delta_Xn + added_fee) * this.pool_leverage
		this.balances.y = balances.y
		this.balances.xn += delta_Xn + added_fee
		this.balances.yn = balances.yn
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.x += total_fee
		
	//	gross_delta=0.1e9

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: gross_delta + x_change}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: 'x',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: initial_price,
			pmax: l_final_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: initial_price,
			pmax: l_final_price,
			amounts: { x: net_delta, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: x_change,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)
		expect(vars['position_' + L + '_1']).to.be.deep.eq({
			owner: this.aliceAddress,
			shares,
			price: avg_share_price,
			ts: unitObj.timestamp,
		})

		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after L', final_price / initial_price)
		expect(final_price).to.be.equalWithPrecision(l_final_price, 12)
		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ final_x5_leveraged_price }, 'growth after L', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		expect(final_x5_leveraged_price).to.be.gt(initial_x5_leveraged_price)
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 6)
		expect(avg_share_price).to.be.lt(final_x5_leveraged_price)
		this.prev_avg_share_price = avg_share_price

		const utilization_ratio = await this.executeGetter('get_utilization_ratio')
		console.log({ utilization_ratio })

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Alice swaps more after buying L-tokens', async () => {
	//	process.exit()
	//	return;
		await this.timetravel()

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ initial_price, initial_x5_leveraged_price })

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits

		const y_change = 1e9
		const final_price = initial_price * (this.mid_price ? 1.05 : 1.1)
		const result = await this.executeGetter('get_swap_amounts_by_final_price', ['y', final_price])
		console.log('result', result)
		const { in: y_amount, out: net_x_amount, arb_profit_tax, fees, balances, leveraged_balances } = result
		this.checkBalancesLeverage(balances)
		const x_amount = net_x_amount + fees.out
		const avg_price = y_amount / x_amount
		expect(avg_price).to.be.gt(initial_price)
		expect(avg_price).to.be.lt(final_price)

		// simple calculation
		const unleveraged_x_amount = Math.floor((this.balances.x + x0) * (1 - (1 + y_amount / (this.balances.y + y0)) ** (-this.beta / this.alpha)))
	//	const unleveraged_x_amount = Math.floor(this.balances.x * y_amount / (this.balances.y + y_amount))
	//	console.log({x_amount, unleveraged_x_amount})
		expect(unleveraged_x_amount).to.be.gt(x_amount)

	//	const y_amount = 100e9
		
	/*	this.balances.x -= x_amount
		this.balances.y += y_amount
		this.balances.xn -= x_amount
		this.balances.yn += y_amount*/
		this.balances = balances
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1) {
			this.profits.x += fees.out
			this.profits.y += fees.in
		}

		const { unit, error } = await this.alice.sendMulti({
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

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('resp vars', response.response.responseVars)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: initial_price,
			pmax: final_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: initial_price,
			pmax: final_price,
			amounts: { x: x_amount, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: y_change,
			},
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: net_x_amount,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deep.eq(this.balances)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)

		// check the final price
		const price = await this.get_price('x')
		expect(price).to.be.equalWithPrecision(final_price, 8)
		this.price = final_price

		console.log({ final_price }, 'growth after swap', final_price / initial_price)
		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ final_x5_leveraged_price }, 'growth after swap', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 6)

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Alice buys even more L-tokens', async () => {
	//	return;
	//	process.exit()
		await this.timetravel()
		const L = 5

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ initial_price, initial_x5_leveraged_price })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits

		const x_change = 1e4
		const delta_Xn = -0.001e9
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['x', L, delta_Xn])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, final_price: l_final_price } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		expect(balances.x).to.be.equalWithPrecision((this.balances.xn + delta_Xn + added_fee) * this.pool_leverage, 12)
		expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(this.leveraged_balances[L + 'x'].supply + shares)
		expect(avg_share_price).to.be.gt(initial_x5_leveraged_price)
		expect(avg_share_price).to.be.gt(this.prev_avg_share_price)
		
		this.balances.x = balances.x
		this.balances.y = balances.y
		this.balances.xn += delta_Xn + added_fee
		this.balances.yn = balances.yn
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.x += total_fee
		
	//	gross_delta=0.1e9

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: gross_delta + x_change}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: 'x',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: initial_price,
			pmax: l_final_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: initial_price,
			pmax: l_final_price,
			amounts: { x: net_delta, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: x_change,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)
		expect(vars['position_' + L + '_2']).to.be.deep.eq({
			owner: this.aliceAddress,
			shares,
			price: avg_share_price,
			ts: unitObj.timestamp,
		})

		const utilization_ratio = await this.executeGetter('get_utilization_ratio')
		console.log({ utilization_ratio })

		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after L', final_price / initial_price)
		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ final_x5_leveraged_price }, 'growth after L', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 5)
		expect(avg_share_price).to.be.lt(final_x5_leveraged_price)

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Alice transfers her leveraged position to Bob', async () => {
	//	return;
		await this.timetravel()

		const L = 5
		const position_id = 'position_' + L + '_1'
		const { vars: old_vars } = await this.alice.readAAStateVars(this.pool_aa)
		const position = old_vars[position_id]

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.pool_aa,
			amount: 10000,
			data: {
				transfer: 1,
				new_owner: this.bobAddress,
				position: position_id,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars['message']).to.be.eq('Transferred')
		
		position.owner = this.bobAddress
		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars[position_id]).to.be.deep.eq(position)
	})


	it('Bob partially closes his leveraged position', async () => {
	//	return;
		await this.timetravel()

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ initial_price, initial_x5_leveraged_price })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits

		const L = 5
		const position_id = 'position_' + L + '_1'
		const { vars: old_vars } = await this.alice.readAAStateVars(this.pool_aa)
		const position = old_vars[position_id]
		console.log('position', position)

		const delta_Xn = 0.001e9
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['x', 5, delta_Xn, position.price])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, final_price: l_final_price } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		expect(net_delta).to.be.lt(0)
		expect(gross_delta).to.be.lt(0)
		expect(shares).to.be.lt(0)
		expect(-shares).to.be.lt(position.shares)
		expect(balances.x).to.be.equalWithPrecision(this.balances.x + (delta_Xn + added_fee) * this.pool_leverage, 12)
		expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(this.leveraged_balances[L + 'x'].supply + shares)
		expect(avg_share_price).to.be.lt(initial_x5_leveraged_price)
		
		this.balances.x += (delta_Xn + added_fee) * this.pool_leverage
		this.balances.y = balances.y
		this.balances.xn += delta_Xn + added_fee
		this.balances.yn = balances.yn
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.x += total_fee
		position.shares += shares
		
	//	gross_delta=0.1e9

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.pool_aa,
			amount: 10000,
			data: {
				sell: 1,
				L: L,
				asset: 'x',
				delta: delta_Xn,
				position: position_id,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log('response vars', response.response.responseVars)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: l_final_price,
			pmax: initial_price,
		}
		this.recent.last_trade = {
			address: this.bobAddress,
			pmin: l_final_price,
			pmax: initial_price,
			amounts: { x: -net_delta, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.bobAddress,
				amount: -gross_delta,
			},
		])

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)
		expect(vars[position_id]).to.be.deep.eq(position)

		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after closing L5', final_price / initial_price)
		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ final_x5_leveraged_price }, 'growth after closing L5', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 4)
		expect(avg_share_price).to.be.gt(final_x5_leveraged_price)

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Alice buys negative L-tokens', async () => {
	//	return;
		await this.timetravel()

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		console.log({ initial_price, initial_x5_leveraged_price })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits

		const delta_Xn = -0.03e9
		const L = 10
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['y', L, delta_Xn])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, final_price: l_final_price } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		const delta_y = -Math.round((this.beta * this.pool_leverage - 1) / this.alpha * delta_Xn)
		expect(balances.y).to.be.eq(this.balances.y + delta_y)
		expect(balances.yn).to.be.equalWithPrecision(this.balances.yn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[-L + 'x'].supply).to.be.eq(shares)
		expect(avg_share_price).to.be.equalWithPrecision(1, 6)
		
		this.balances.x = balances.x
		this.balances.y += delta_y
		this.balances.xn = balances.xn
		this.balances.yn += delta_Xn + added_fee
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.y += total_fee

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.y_asset]: [{address: this.pool_aa, amount: gross_delta}],
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: 'y',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: 1/l_final_price,
			pmax: initial_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: 1/l_final_price,
			pmax: initial_price,
			amounts: { y: net_delta, x: 0 },
			paid_taxes: { y: arb_profit_tax, x: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit })
	/*	expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this['leveraged_asset' + (-L)],
				address: this.aliceAddress,
				amount: shares,
			},
		])*/

		const position_id = 'position_' + (-L) + '_3'
		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)
		expect(vars[position_id]).to.be.deep.eq({
			owner: this.aliceAddress,
			shares,
			price: avg_share_price,
			ts: unitObj.timestamp,
		})

		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after -L10', final_price / initial_price)
		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const final_y10_leveraged_price = await this.get_leveraged_price('y', L)
		console.log({final_y10_leveraged_price})
		console.log({ final_x5_leveraged_price }, 'growth after -L10', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 6)
		expect(avg_share_price).to.be.lt(final_y10_leveraged_price)
		this.prev_avg_share_price = avg_share_price

		this.checkBalancesLeverage()
		await this.checkTotals()
	})

	it('Alice buys more negative L-tokens', async () => {
	//	return;
		await this.timetravel()

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const initial_y10_leveraged_price = await this.get_leveraged_price('y', 10)
		console.log({ initial_price, initial_x5_leveraged_price, initial_y10_leveraged_price })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits

		const delta_Xn = -0.2e9
		const L = 10
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['y', L, delta_Xn])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, final_price: l_final_price } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		const delta_y = -Math.round((this.beta * this.pool_leverage - 1) / this.alpha * delta_Xn)
		expect(balances.y).to.be.equalWithPrecision(this.balances.y + delta_y, 12)
		expect(balances.yn).to.be.equalWithPrecision(this.balances.yn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[-L + 'x'].supply).to.be.eq(this.leveraged_balances[-L + 'x'].supply + shares)
		expect(avg_share_price).to.be.gt(initial_y10_leveraged_price)
	//	expect(avg_share_price).to.be.gt(this.prev_avg_share_price) // might be less due to interest
		
		this.balances.x = balances.x
		this.balances.y += delta_y
		this.balances.xn = balances.xn
		this.balances.yn += delta_Xn + added_fee
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.y += total_fee

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.y_asset]: [{address: this.pool_aa, amount: gross_delta}],
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
					tokens: 1,
					L: L,
					asset: 'y',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: 1/l_final_price,
			pmax: initial_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: 1/l_final_price,
			pmax: initial_price,
			amounts: { y: net_delta, x: 0 },
			paid_taxes: { y: arb_profit_tax, x: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this['leveraged_asset' + (-L)],
				address: this.aliceAddress,
				amount: shares,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)

		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after -L10', final_price / initial_price)
		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const final_y10_leveraged_price = await this.get_leveraged_price('y', 10)
		console.log({ final_x5_leveraged_price }, 'growth after -L10', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 6)
		expect(final_y10_leveraged_price / initial_y10_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (-10 + 1), 6)
		expect(avg_share_price).to.be.lt(final_y10_leveraged_price)

		this.checkBalancesLeverage()
		await this.checkTotals()
	})


	it('Alice adds more liquidity again and the profits get added to the pool', async () => {
		await this.timetravel('90d')

		console.log('profits', this.profits)
		const initial_price = await this.get_price('x', false)
		const initial_price_after_interest = await this.get_price('x')
		console.log({ initial_price, initial_price_after_interest })
		
		const { balances, profits } = await this.executeGetter('get_balances_after_interest')
		this.balances = balances
		this.profits = profits
		this.checkBalancesLeverage()

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const x_change = 0
		const y_change = 0
		let x_amount = 0.1e9
		let y_amount = Math.round(x_amount * this.balances.y / this.balances.x)
		console.log({x_amount, y_amount})

		this.price = this.alpha / this.beta * (this.balances.y + y0) / (this.balances.x + x0)
		const share_price_in_y = (this.balances.yn + this.balances.xn * this.price) / this.linear_shares
		const share_price_in_x = share_price_in_y / this.price // the current price is already the lowest (the worst for the user)

		if (this.pool_leverage === 1) {
			var excess_y = 0
			const proportional_profits_x = (this.balances.xn / this.balances.yn * this.profits.y);
			var remaining_profits_x = this.profits.x - proportional_profits_x
			const symmetric_moved_profit_shares = this.profits.y / this.balances.yn * this.linear_shares
			//expect(remaining_profits_x).to.be.gt(0)
			console.log({ proportional_profits_y: this.profits.y, proportional_profits_x, remaining_profits_x, symmetric_moved_profit_shares })

			const proportional_shares = (x_amount / this.balances.x * this.linear_shares)
			const pools_shares_for_x = remaining_profits_x / share_price_in_x
			const moved_profit_shares = (pools_shares_for_x + symmetric_moved_profit_shares)
			var new_linear_shares = Math.floor(proportional_shares - pools_shares_for_x)
			var coef = (this.linear_shares + symmetric_moved_profit_shares + proportional_shares) / (this.linear_shares + new_linear_shares)
			console.log({ proportional_shares, pools_shares_for_x, moved_profit_shares, new_linear_shares, share_price_in_x, share_price_in_y, coef })

			// this.balances.x += proportional_profits_x
			// this.balances.y += this.profits.y
			// this.balances.xn += proportional_profits_x
			// this.balances.yn += this.profits.y

			this.balances.x += x_amount + proportional_profits_x
			this.balances.y += y_amount + this.profits.y
			this.balances.xn += x_amount + proportional_profits_x
			this.balances.yn += y_amount + this.profits.y
			}
		else {
			var remaining_profits_x = 0
			x_amount = 4e9 // required for large pool leverage values such as 100
			const target_yn = (this.balances.y / this.pool_leverage)
			const delta_xn1 = (this.balances.yn / target_yn - 1) * this.balances.xn
			expect(delta_xn1).to.be.lte(x_amount)

			// to avoid rounding errors, recalc y_amount based on the ratio of net balances, like oscript does
			var y_amount_exact = (x_amount * this.balances.yn / (this.balances.xn + delta_xn1))
			y_amount = Math.round(y_amount_exact)
			console.log({ x_amount, y_amount, y2x: this.balances.yn / (this.balances.xn + delta_xn1), remaining_x: x_amount - delta_xn1, remaining_y: y_amount })
			
			var excess_y_exact = delta_xn1 * this.balances.yn / (this.balances.xn + delta_xn1)
			var excess_y = Math.floor(delta_xn1 * this.balances.yn / (this.balances.xn + delta_xn1))
		//	var excess_y = Math.round(delta_xn1 * this.balances.y / this.balances.x)
			const shares1 = delta_xn1 / share_price_in_x
			console.log({share_price_in_x, shares1, delta_xn1})
			const proportional_shares = (x_amount - delta_xn1) / (this.balances.xn + delta_xn1) * (this.linear_shares + shares1)
			var new_linear_shares = Math.floor(proportional_shares + shares1)
			var coef = 1
			console.log({ proportional_shares, shares1, new_linear_shares, delta_xn1, target_yn, excess_y, excess_y_exact })

			this.balances.x += x_amount * this.pool_leverage
			this.balances.y += (y_amount_exact * this.pool_leverage)
			this.balances.xn += x_amount
			this.balances.yn += y_amount_exact - excess_y_exact
		}
		const new_issued_shares = this.quadratic
			? Math.floor(Math.sqrt(this.linear_shares + new_linear_shares)) - this.issued_shares
			: new_linear_shares


		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: x_amount + x_change + this.bounce_fee_on_top}],
				[this.y_asset]: [{address: this.pool_aa, amount: y_amount + y_change}],
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
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
	//	await this.network.witnessUntilStable(response.response_unit)

		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.shares_asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: Math.floor(remaining_profits_x),
			},
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: y_change + excess_y,
			},
		], 1)

		if (this.pool_leverage === 1) {
			this.profits.x = 0
			this.profits.y = 0
		}
		this.linear_shares += new_linear_shares
		this.issued_shares += new_issued_shares
		this.coef *= coef

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.closeTo(this.issued_shares, 1)
		expect(vars.lp_shares.linear).to.be.closeTo(this.linear_shares, 1)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 11)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 1)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)

		this.balances = vars.balances
		this.profits = vars.profits
		this.linear_shares = vars.lp_shares.linear
		this.issued_shares = vars.lp_shares.issued

		this.checkBalancesLeverage()
		await this.checkTotals()

		const final_price = await this.get_price('x')
		console.log({ final_price, diff: final_price / initial_price - 1 })
		expect(final_price).to.be.equalWithPrecision(initial_price, 5)
	})


	it('Alice buys L-100-tokens', async () => {
	//	process.exit()
		await this.timetravel()

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const initial_y10_leveraged_price = await this.get_leveraged_price('y', 10)
		console.log({ initial_price, initial_x5_leveraged_price, initial_y10_leveraged_price })

		const { profits, balances: bal } = await this.executeGetter('get_balances_after_interest')
		console.log({ profits, bal })
		this.profits = profits
		this.checkBalancesLeverage(bal)

		const delta_Xn = -0.004e9
		const L = 100
		const result = await this.executeGetter('get_leveraged_trade_amounts', ['x', L, delta_Xn])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, final_price: l_final_price } = result
		this.checkBalancesLeverage(balances)
		const added_fee = this.pool_leverage === 1 ? 0 : total_fee
		expect(balances.x).to.be.equalWithPrecision((this.balances.xn + delta_Xn + added_fee) * this.pool_leverage, 12)
		expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_Xn + added_fee, 12)
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(shares)
		expect(avg_share_price).to.be.equalWithPrecision(1, 4)
		
		this.balances.x = balances.x
		this.balances.y = balances.y
		this.balances.xn += delta_Xn + added_fee
		this.balances.yn = balances.yn
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1)
			this.profits.x += total_fee

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: gross_delta}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: 'x',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: initial_price,
			pmax: l_final_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: initial_price,
			pmax: l_final_price,
			amounts: { x: net_delta, y: 0 },
			paid_taxes: { x: arb_profit_tax, y: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.0001)

		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after L', final_price / initial_price)
		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const final_x100_leveraged_price = await this.get_leveraged_price('x', 100)
		const final_y10_leveraged_price = await this.get_leveraged_price('y', 10)
		console.log({ final_x5_leveraged_price }, 'growth after L', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 6)
		expect(final_y10_leveraged_price / initial_y10_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (-10 + 1), 6)
		expect(avg_share_price).to.be.lt(final_x100_leveraged_price)

		this.checkBalancesLeverage()
		await this.checkTotals()
	})



	it('Alice swaps x to y by final price', async () => {
		await this.timetravel()

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const initial_x100_leveraged_price = await this.get_leveraged_price('x', 100)
		const initial_y10_leveraged_price = await this.get_leveraged_price('y', 10)
		console.log({ initial_price, initial_x5_leveraged_price, initial_y10_leveraged_price, initial_x100_leveraged_price })

		const { profits } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const x_change = 0
		const final_y_price = 1/initial_price * (this.mid_price ? 1.05 : 1.1)
		const result = await this.executeGetter('get_swap_amounts_by_final_price', ['x', final_y_price])
		console.log('result', result)
		const { in: x_amount, out: net_y_amount, arb_profit_tax, fees, balances, leveraged_balances } = result
		this.checkBalancesLeverage(balances)
		const y_amount = net_y_amount + fees.out
		const avg_price = x_amount / y_amount
		expect(avg_price).to.be.gt(1 / initial_price)
		expect(avg_price).to.be.lt(final_y_price)

		// simple calculation
		const unleveraged_y_amount = Math.floor((this.balances.y + y0) * (1 - (1 + x_amount / (this.balances.x + x0)) ** (-this.alpha / this.beta)))
	//	const unleveraged_x_amount = Math.floor(this.balances.x * y_amount / (this.balances.y + y_amount))
	//	console.log({x_amount, unleveraged_x_amount})
		expect(unleveraged_y_amount).to.be.gt(y_amount)
		
		this.balances = balances
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1) {
			this.profits.y += fees.out
			this.profits.x += fees.in
		}

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.pool_aa, amount: x_amount + x_change}],
				...this.bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					final_price: final_y_price,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: 1/final_y_price,
			pmax: initial_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: 1/final_y_price,
			pmax: initial_price,
			amounts: { y: y_amount, x: 0 },
			paid_taxes: { y: arb_profit_tax, x: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: x_change,
			},
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: net_y_amount,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deep.eq(this.balances)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		// check the final price
		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after swap', final_price / initial_price)
		expect(final_price).to.be.equalWithPrecision(1/final_y_price, 9)
		this.price = final_price

		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const final_x100_leveraged_price = await this.get_leveraged_price('x', 100)
		const final_y10_leveraged_price = await this.get_leveraged_price('y', 10)
		console.log({ final_x5_leveraged_price }, 'growth after swap', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		console.log({ final_x100_leveraged_price })
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 5)
		expect(final_x100_leveraged_price / initial_x100_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (100 - 1), 5)
		expect(final_y10_leveraged_price / initial_y10_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (-10 + 1), 6)

		this.checkBalancesLeverage()
		await this.checkTotals()
		console.log('leveraged_balances', vars.leveraged_balances)
		console.log('profits', vars.profits)
	})


	it('Alice votes for new swap fee', async () => {
		this.name = 'swap_fee'
		this.value = 0.001
		this.amount = Math.floor(this.issued_shares * 0.1)

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{address: this.governance_aa, amount: 1e4}],
				[this.shares_asset]: [{address: this.governance_aa, amount: this.amount}],
			},
			messages: [{
				app: 'data',
				payload: {
					name: this.name,
					value: this.value,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(this.amount)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['challenging_period_start_ts_' + this.name]).to.be.equal(response.timestamp)
	})

	it('Bob waits for 4 days and then commits the new swap fee successfully', async () => {
		await this.timetravel('4d')

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars: gvars } = await this.bob.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(this.amount)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars[this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars[this.name]).to.be.equal(this.value)

		this.swap_fee = this.value
	})


	it('Alice votes for a new alpha', async () => {
		if (this.mid_price)
			return console.log("skipping because mid price is set");
		this.name = 'alpha'
		this.value = 0.3

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				value: this.value,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(this.amount)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['challenging_period_start_ts_' + this.name]).to.be.equal(response.timestamp)
	})

	it('Bob waits for 4 days and then commits the new alpha successfully', async () => {
		if (this.mid_price)
			return console.log("skipping because mid price is set");
		await this.timetravel('4d')

		const initial_price = await this.get_price('x')
		const { vars: { balances: initial_balances, profits: initial_profits } } = await this.bob.readAAStateVars(this.pool_aa)
		console.log('profits from vars before changing alpha', initial_profits)
		console.log('balances from vars before changing alpha', initial_balances)

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars: gvars } = await this.bob.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(this.amount)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars[this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars[this.name]).to.be.equal(this.value)

		this.alpha = this.value
		this.beta = 1 - this.alpha

		this.balances = vars.balances
		this.profits = vars.profits
		console.log('profits after changing alpha', this.profits);
		console.log('balances after changing alpha', this.balances);
		this.checkBalancesLeverage()

		const final_price = await this.get_price('x')
		expect(final_price).to.be.equalWithPrecision(initial_price, 12)

		await this.checkTotals()
	})


	it('Alice votes for a new Lambda (pool leverage)', async () => {
		if (this.mid_price)
			return console.log("skipping because mid price is set");
		this.name = 'pool_leverage'
		this.value = this.pool_leverage === 1 ? 10 : 1

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				value: this.value,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(this.amount)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['challenging_period_start_ts_' + this.name]).to.be.equal(response.timestamp)
	})


	it('Alice adds profits to the pool', async () => {
		await this.timetravel('3d')

		console.log('profits', this.profits)
		const initial_price = await this.get_price('x', false)
		const initial_price_after_interest = await this.get_price('x')
		console.log({ initial_price, initial_price_after_interest })
		
		const { balances, profits } = await this.executeGetter('get_balances_after_interest')
		this.balances = balances
		this.profits = profits
		this.checkBalancesLeverage()

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		this.price = this.alpha / this.beta * (this.balances.y + y0) / (this.balances.x + x0)

		if (this.pool_leverage === 1) {
			const proportional_profits_x = (this.balances.xn / this.balances.yn * this.profits.y);
			if (proportional_profits_x <= this.profits.x) {
				var symmetric_moved_profit_shares = this.profits.y / this.balances.yn * this.linear_shares
				var moved_profits_y = this.profits.y
				var moved_profits_x = proportional_profits_x
			}
			else {
				const proportional_profits_y = (this.balances.yn / this.balances.xn * this.profits.x);
				var symmetric_moved_profit_shares = this.profits.x / this.balances.xn * this.linear_shares
				var moved_profits_x = this.profits.x
				var moved_profits_y = proportional_profits_y
			}
			//expect(remaining_profits_x).to.be.gt(0)
			console.log({ proportional_profits_y: this.profits.y, proportional_profits_x, symmetric_moved_profit_shares })

			const coef = (this.linear_shares + symmetric_moved_profit_shares) / this.linear_shares

			this.balances.x += moved_profits_x
			this.balances.y += moved_profits_y
			this.balances.xn += moved_profits_x
			this.balances.yn += moved_profits_y
			this.profits.x -= moved_profits_x
			this.profits.y -= moved_profits_y
			this.coef *= coef
		}

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.pool_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				add_profits: 1,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
	//	console.log('logs', JSON.stringify(response.logs, null, 2))

		this.recent.last_ts = response.timestamp

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 10)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.01)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		this.balances = vars.balances
		this.profits = vars.profits

		this.checkBalancesLeverage()
		await this.checkTotals()

		const final_price = await this.get_price('x')
		console.log({ final_price, diff: final_price / initial_price - 1 })
		expect(final_price).to.be.equalWithPrecision(initial_price, 5)
	})


	it('Alice adds more liquidity in order to add the remaining profits to the pool', async () => {
		if (this.pool_leverage > 1)
			return console.log(`skipping as Lambda > 1`)
		if (this.profits.x === 0 && this.profits.y === 0)
			return console.log(`skipping as profits are 0`)
		expect(this.profits.x === 0 || this.profits.y === 0).to.be.true
		
		console.log('profits', this.profits)
		const initial_price = await this.get_price('x', false)
		const initial_price_after_interest = await this.get_price('x')
		console.log({ initial_price, initial_price_after_interest })

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		if (this.profits.x) {
			var y_amount = Math.ceil(this.profits.x * this.balances.y / this.balances.x)
			var x_amount = 0
			var proportional_shares = Math.min(y_amount / this.balances.y, this.profits.x / this.balances.x) * this.linear_shares
			var moved_profit_x = Math.min(y_amount * this.balances.x / this.balances.y, this.profits.x)
			var moved_profit_y = 0
		}
		else {
			var x_amount = Math.ceil(this.profits.y * this.balances.x / this.balances.y)
			var y_amount = 0
			var proportional_shares = Math.min(x_amount / this.balances.x, this.profits.y / this.balances.y) * this.linear_shares
			var moved_profit_y = Math.min(x_amount * this.balances.y / this.balances.x, this.profits.y)
			var moved_profit_x = 0
		}
		console.log({ x_amount, y_amount, moved_profit_x, moved_profit_y })

		this.price = this.alpha / this.beta * (this.balances.y + y0) / (this.balances.x + x0)
		const share_price_in_y = (this.balances.yn + this.balances.xn * this.price) / this.linear_shares
		const share_price_in_x = share_price_in_y / this.price

		const new_linear_shares = Math.floor(proportional_shares - moved_profit_x / share_price_in_x - moved_profit_y / share_price_in_y)
		const coef = (this.linear_shares + proportional_shares) / (this.linear_shares + new_linear_shares)

		this.balances.x += x_amount + moved_profit_x
		this.balances.y += y_amount + moved_profit_y
		this.balances.xn += x_amount + moved_profit_x
		this.balances.yn += y_amount + moved_profit_y
		this.profits.x -= moved_profit_x
		this.profits.y -= moved_profit_y
		
		const new_issued_shares = this.quadratic
			? Math.floor(Math.sqrt(this.linear_shares + new_linear_shares)) - this.issued_shares
			: new_linear_shares


		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				...(x_amount && {[this.x_asset]: [{address: this.pool_aa, amount: x_amount + this.bounce_fee_on_top}]}),
				...(y_amount && {[this.y_asset]: [{address: this.pool_aa, amount: y_amount }]}),
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
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
	//	await this.network.witnessUntilStable(response.response_unit)

		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.shares_asset,
				address: this.aliceAddress,
				amount: new_issued_shares,
			},
		])

		this.linear_shares += new_linear_shares
		this.issued_shares += new_issued_shares
		this.coef *= coef

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.closeTo(this.issued_shares, 1)
		expect(vars.lp_shares.linear).to.be.closeTo(this.linear_shares, 1)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 11)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 1)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 1)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		this.balances = vars.balances
		this.profits = vars.profits
		this.linear_shares = vars.lp_shares.linear
		this.issued_shares = vars.lp_shares.issued

		this.checkBalancesLeverage()
		await this.checkTotals()

		const final_price = await this.get_price('x')
		console.log({ final_price, diff: final_price / initial_price - 1 })
		expect(final_price).to.be.equalWithPrecision(initial_price, 5)
	})


	it('Bob waits for 4 days and then commits the new Lambda successfully', async () => {
		if (this.mid_price)
			return console.log("skipping because mid price is set");
		await this.timetravel('4d')

		const initial_price = await this.get_price('x')
		const { vars: { balances: initial_balances, profits: initial_profits } } = await this.bob.readAAStateVars(this.pool_aa)
		console.log('balances from vars before changing Lambda', initial_balances)
		if (this.pool_leverage === 1) {
			initial_profits.x = 0
			initial_profits.y = 0
		}
		const total_x = initial_balances.xn + initial_profits.x
		const total_y = initial_balances.yn + initial_profits.y
		this.balances = initial_balances
		this.balances.x *= this.value / this.pool_leverage
		this.balances.y *= this.value / this.pool_leverage
		if (this.value === 1) {
			this.profits.x += this.balances.xn - this.balances.x
			this.profits.y += this.balances.yn - this.balances.y
			this.balances.xn = this.balances.x
			this.balances.yn = this.balances.y
		}
		if (this.pool_leverage === 1) {
			this.canceled_profits.x = this.profits.x
			this.canceled_profits.y = this.profits.y
			this.profits.x = 0
			this.profits.y = 0
		}

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars: gvars } = await this.bob.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(this.amount)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars[this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars[this.name]).to.be.equal(this.value)
		expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.01)
		expect(vars.balances.xn + vars.profits.x).to.be.closeTo(total_x, 0.001)
		expect(vars.balances.yn + vars.profits.y).to.be.closeTo(total_y, 0.001)

		this.profits = vars.profits
		this.balances = vars.balances
		this.pool_leverage = this.value

		console.log('balances after changing Lambda', this.balances);
		this.checkBalancesLeverage()

		const final_price = await this.get_price('x')
		expect(final_price).to.be.equalWithPrecision(initial_price, 12)

		await this.checkTotals(false)
	})


	it('Alice votes for a new mid price', async () => {
		if (!this.mid_price)
			return console.log("skipping because we are not range trading");
		this.name = 'mid_price'
		this.value = 70

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				value: this.value,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(this.amount)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['challenging_period_start_ts_' + this.name]).to.be.equal(response.timestamp)
	})

	it('Bob waits for 4 days and then commits the new mid price successfully', async () => {
		if (!this.mid_price)
			return console.log("skipping because we are not range trading");
		await this.timetravel('4d')

		const initial_price = await this.get_price('x')
		const { vars: { balances: initial_balances, profits: initial_profits, lp_shares: initial_lp_shares } } = await this.bob.readAAStateVars(this.pool_aa)
		console.log('balances from vars before changing mid_price', initial_balances)
		console.log('lp_shares before changing mid_price', initial_lp_shares);
		const total_x = initial_balances.xn + initial_profits.x
		const total_y = initial_balances.yn + initial_profits.y
		this.balances = initial_balances

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
				commit: 1,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars: gvars } = await this.bob.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(this.amount)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.equal(this.amount)
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars[this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)

		const { vars } = await this.bob.readAAStateVars(this.pool_aa)
		expect(vars[this.name]).to.be.equal(this.value)
	//	expect(vars.balances).to.be.deepCloseTo(this.balances, 0.01)
	//	expect(vars.profits).to.be.deepCloseTo(this.profits, 0.01)
		expect(vars.balances.xn + vars.profits.x).to.be.equalWithPrecision(total_x, 12)
		expect(vars.balances.yn + vars.profits.y).to.be.equalWithPrecision(total_y, 12)

		this.profits = vars.profits
		this.balances = vars.balances
		this.mid_price = this.value

		console.log('balances after changing mid_price', this.balances);
		console.log('lp_shares after changing mid_price', vars.lp_shares);
		this.checkBalancesLeverage()

		const final_price = await this.get_price('x')
		expect(final_price).to.be.equalWithPrecision(initial_price, 12)

		await this.checkTotals()
	})

	it('Alice removes support from swap_fee', async () => {
		await this.network.timetravel({ shift: '30d' })

		this.name = 'swap_fee'
		this.value = 0.001

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(0)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)
	})

	it('Alice removes support from alpha', async () => {
		this.name = 'alpha'
		this.value = 0.3

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(0)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)
	})

	it('Alice removes support from pool_leverage', async () => {
		if (this.mid_price)
			return console.log("skipping because mid price is set");
		this.name = 'pool_leverage'
		this.value = this.pool_leverage

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(0)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)
	})

	it('Alice removes support from mid_price', async () => {
		if (!this.mid_price)
			return console.log("skipping because we are not range trading");
		this.name = 'mid_price'
		this.value = 70

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				name: this.name,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['support_' + this.name + '_' + this.value]).to.be.equal(0)
		expect(gvars['support_' + this.name + '_' + this.value + '_' + this.aliceAddress]).to.be.undefined
		expect(gvars['leader_' + this.name]).to.be.equal(this.value)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(this.amount)
	})

	it('Alice withdraws from governance', async () => {
		await this.timetravel()

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.governance_aa,
			amount: 1e4,
			spend_unconfirmed: 'all',
			data: {
				withdraw: 1,
			}
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.shares_asset,
				address: this.aliceAddress,
				amount: this.amount,
			},
		])

		const { vars: gvars } = await this.alice.readAAStateVars(this.governance_aa)
		expect(gvars['balance_' + this.aliceAddress]).to.be.equal(0)
	})

	it('Alice swaps x to y by delta x', async () => {
		await this.timetravel()

		const initial_price = await this.get_price('x')
		const initial_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const initial_x100_leveraged_price = await this.get_leveraged_price('x', 100)
		const initial_y10_leveraged_price = await this.get_leveraged_price('y', 10)
		console.log({ initial_price, initial_x5_leveraged_price, initial_y10_leveraged_price, initial_x100_leveraged_price })

		const { profits, balances: initial_balances, leveraged_balances: initial_leveraged_balances } = await this.executeGetter('get_balances_after_interest')
		this.profits = profits
		console.log('balances after interest', { initial_balances, initial_leveraged_balances })
		expect(initial_balances).to.be.deep.eq(this.balances)

		const { x0, y0, p_max, p_min } = await this.executeGetter('get_shifts_and_bounds')
		console.log({ x0, y0, p_max, p_min })

		const x_change = 0
		const delta_xn = this.pool_leverage === 1 ? 0.2e9 : 0.5e9
		const result = await this.executeGetter('get_swap_amounts_by_delta_net_balance', ['x', delta_xn])
		console.log('result', result)
		const { in: x_amount, out: net_y_amount, arb_profit_tax, fees, balances, leveraged_balances, final_price: final_y_price } = result
		this.checkBalancesLeverage(balances)
		if (this.pool_leverage === 1)
			expect(balances.xn).to.be.equalWithPrecision(this.balances.xn + delta_xn, 12)
		else
			expect(balances.xn).to.be.within(this.balances.xn + delta_xn, this.balances.xn + delta_xn + fees.in + 0.001)
		expect(result.initial_price).to.be.equalWithPrecision(1/initial_price, 13)
		const y_amount = net_y_amount + fees.out
		const avg_price = x_amount / y_amount
		expect(avg_price).to.be.gt(1 / initial_price)
		expect(avg_price).to.be.lt(final_y_price)

		// simple calculation (unleveraged refers to L-pools, not to pool leverage Lambda)
		const unleveraged_y_amount = Math.floor((this.balances.y + y0) * (1 - (1 + x_amount / (this.balances.x + x0)) ** (-this.alpha / this.beta)))
		// not always the case: we can get more even despite L-pools due to selling a fully leveraged token and adding more virtual liquidity
		if (this.pool_leverage === 1)
			expect(unleveraged_y_amount).to.be.gt(y_amount)
		
		this.balances = balances
		this.leveraged_balances = leveraged_balances
		if (this.pool_leverage === 1) {
			this.profits.y += fees.out
			this.profits.x += fees.in
		}

		const { unit, error } = await this.alice.sendMulti({
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

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.recent.prev = this.recent.current
		this.recent.current = {
			start_ts: Math.floor(response.timestamp / 3600) * 3600,
			pmin: 1/final_y_price,
			pmax: initial_price,
		}
		this.recent.last_trade = {
			address: this.aliceAddress,
			pmin: 1/final_y_price,
			pmax: initial_price,
			amounts: { y: y_amount, x: 0 },
			paid_taxes: { y: arb_profit_tax, x: 0 },
		}
		this.recent.last_ts = response.timestamp

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: x_change,
			},
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: net_y_amount,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.balances).to.be.deep.eq(this.balances)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		this.balances = vars.balances
		this.profits = vars.profits
		this.recent = vars.recent

		// check the final price
		const final_price = await this.get_price('x')
		console.log({ final_price }, 'growth after swap', final_price / initial_price)
		expect(final_price).to.be.equalWithPrecision(1/final_y_price, 9)
		this.price = final_price

		const final_x5_leveraged_price = await this.get_leveraged_price('x', 5)
		const final_x100_leveraged_price = await this.get_leveraged_price('x', 100)
		const final_y10_leveraged_price = await this.get_leveraged_price('y', 10)
		console.log({ final_x5_leveraged_price }, 'growth after swap', final_x5_leveraged_price / initial_x5_leveraged_price, 'expected', (final_price / initial_price) ** (5 - 1))
		console.log({ final_x100_leveraged_price })
		expect(final_x5_leveraged_price / initial_x5_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (5 - 1), 5)
		expect(final_x100_leveraged_price / initial_x100_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (100 - 1), 5)
		expect(final_y10_leveraged_price / initial_y10_leveraged_price).to.be.equalWithPrecision((final_price / initial_price) ** (-10 + 1), 6)

		this.checkBalancesLeverage()
		await this.checkTotals()
		console.log('leveraged_balances', vars.leveraged_balances)
		console.log('profits', vars.profits)
	})


	it('Alice removes liquidity with preferred asset', async () => {
		if (this.pool_leverage === 1)
			return;
	//	expect(this.balances.y / this.pool_leverage).to.be.equalWithPrecision(this.balances.yn, 12)
	//	expect(this.balances.x / this.pool_leverage).to.be.equalWithPrecision(this.balances.xn, 12)
		const excess_x_balance = this.balances.xn - this.balances.x / this.pool_leverage
		const excess_y_balance = this.balances.yn - this.balances.y / this.pool_leverage
		const min_price = Math.min(this.recent.current.pmin, this.recent.prev.pmin)
		const max_price = Math.max(this.recent.current.pmax, this.recent.prev.pmax)
		const share_price_in_x = (this.balances.xn + this.balances.yn / max_price) / this.linear_shares * (1 - this.exit_fee)
		const share_price_in_y = (this.balances.yn + this.balances.xn * min_price) / this.linear_shares * (1 - this.exit_fee)
		const shares_for_excess_x = excess_x_balance / share_price_in_x
		const shares_for_excess_y = excess_y_balance / share_price_in_y
		const preferred_asset = shares_for_excess_x > shares_for_excess_y ? this.x_asset : this.y_asset

		let redeemed_linear_shares = Math.ceil(0.0 * this.linear_shares + shares_for_excess_y + shares_for_excess_x)
		const redeemed_issued_shares = this.quadratic
			? this.issued_shares - Math.round(Math.sqrt(this.linear_shares - redeemed_linear_shares))
			: redeemed_linear_shares
		if (this.quadratic)
			redeemed_linear_shares = this.linear_shares - (this.issued_shares - redeemed_issued_shares) ** 2
		const shares_for_proportional_redemption = redeemed_linear_shares - shares_for_excess_y - shares_for_excess_x
		const x_amount_exact = excess_x_balance + shares_for_proportional_redemption / this.linear_shares * (this.balances.xn - excess_x_balance) * (1 - this.exit_fee)
		const y_amount_exact = excess_y_balance + shares_for_proportional_redemption / this.linear_shares * (this.balances.yn - excess_y_balance) * (1 - this.exit_fee)
		const x_amount = Math.floor(x_amount_exact)
		const y_amount = Math.floor(y_amount_exact)
		console.log({ shares_for_excess_x, shares_for_excess_y, redeemed_linear_shares, shares_for_proportional_redemption, excess_x_balance, excess_y_balance, x_amount_exact, y_amount_exact, preferred_asset, share_price_in_x, share_price_in_y, max_price, min_price }, this.recent)
		
		this.balances.x -= (x_amount - excess_x_balance) * this.pool_leverage
		this.balances.y -= (y_amount - excess_y_balance) * this.pool_leverage
		this.balances.xn -= x_amount
		this.balances.yn -= y_amount
		this.linear_shares -= redeemed_linear_shares
		this.issued_shares -= redeemed_issued_shares

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{address: this.pool_aa, amount: 1e4}],
				[this.shares_asset]: [{address: this.pool_aa, amount: redeemed_issued_shares}],
			},
			messages: [{
				app: 'data',
				payload: {
					preferred_asset: preferred_asset,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.equalPayments([
			{
				asset: this.x_asset,
				address: this.aliceAddress,
				amount: x_amount,
			},
			{
				asset: this.y_asset,
				address: this.aliceAddress,
				amount: y_amount,
			},
		])

		const { vars } = await this.alice.readAAStateVars(this.pool_aa)
		expect(vars.lp_shares.issued).to.be.eq(this.issued_shares)
		expect(vars.lp_shares.linear).to.be.eq(this.linear_shares)
		expect(vars.lp_shares.coef).to.be.equalWithPrecision(this.coef, 11)
		expect(vars.balances).to.be.deepCloseTo(this.balances, this.pool_leverage)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)
		expect(vars.profits).to.be.deepCloseTo(this.profits, 0.001)
		expect(vars.recent).to.be.deepCloseTo(this.recent, 0.001)

		this.balances = vars.balances

	//	this.checkBalancesLeverage(null, true)
		expect(this.balances.x / this.pool_leverage / this.balances.xn).to.be.equalWithPrecision(1, 8)
		expect(this.balances.y / this.pool_leverage / this.balances.yn).to.be.equalWithPrecision(1, 8)

		await this.checkTotals()
	})

	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
